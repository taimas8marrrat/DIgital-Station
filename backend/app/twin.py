"""Цифровой двойник станции: состояние путей, поездов и ресурсов; исполнение принятого плана;
обнаружение конфликтов; подготовка задачи для планировщика."""
from __future__ import annotations

from collections import deque

from .config import RESOURCES, STATION
from .planner import INSPECTION_MIN, LOCO_MIN, CREW_MIN, allowed_tracks
from .timetable import instances

DEFAULT_SPEED_KMH = 80


class Twin:
    def __init__(self, cfg):
        self.cfg = cfg
        self.station = STATION
        self.tracks = {t["id"]: t for t in STATION["tracks"]}
        self.dir_throat = {k: v["throat"] for k, v in STATION["directions"].items()}
        self.switch_tracks = {s["id"]: (s["throat"], s["tracks"]) for s in STATION["switches"]}
        self.caps = {k: v["capacity"] for k, v in RESOURCES.items() if not k.startswith("_")}
        self.now: float | None = None
        self.speed = 1.0
        self.trains: dict[str, dict] = {}
        self.loaded_until = 0.0
        self.plan: dict[str, dict] = {}         # принятый план: id -> {track, arr, dep} (сим-секунды)
        self.plan_meta: dict = {"version": 0, "method": None}
        self.closures: dict[int, float] = {}    # путь -> до какого времени закрыт
        self.switch_fail: dict[str, float] = {}
        self.departed: deque = deque(maxlen=400)
        self.log: deque = deque(maxlen=60)       # журнал для UI

    # ------------------------------------------------------------ загрузка расписания
    def _load(self):
        horizon = self.cfg.planner["horizon_min"] * 60
        start = max(self.loaded_until, self.now - 600)
        end = self.now + horizon + 3600
        if end <= self.loaded_until:
            return
        for inst in instances(start, end):
            if inst["id"] in self.trains:
                continue
            inst.update({"status": "scheduled", "km": None, "eta": inst["planned_arr"], "delay_min": 0,
                         "track": None, "actual_arr": None, "actual_dep": None, "ready": None, "extra_min": 0,
                         "from_throat": self.dir_throat[inst["from"]], "to_throat": self.dir_throat[inst["to"]],
                         "signal_since": None})
            self.trains[inst["id"]] = inst
        self.loaded_until = end

    def note(self, kind, **params):
        self.log.appendleft({"ts": self.now, "kind": kind, **params})

    # ------------------------------------------------------------ события
    def apply(self, ev: dict) -> bool:
        """Применить событие. Возвращает True, если событие значимо для плана."""
        typ = ev["type"]
        if typ == "clock":
            self.now = ev["ts"]
            if ev.get("speed_factor"):
                self.speed = ev["speed_factor"]
            self._load()
            return self.advance()
        if self.now is None:
            return False
        t = self.trains.get(ev.get("train")) if ev.get("train") else None
        if typ == "position" and t and t["status"] in ("scheduled", "approaching"):
            t["status"] = "approaching"
            t["km"] = ev["km"]
            spd = ev.get("speed") or DEFAULT_SPEED_KMH
            t["eta"] = ev["ts"] + ev["km"] / spd * 3600
            return False
        if typ == "at_signal" and t and t["status"] in ("scheduled", "approaching"):
            t["status"] = "waiting_signal"
            t["km"] = 0
            t["eta"] = ev["ts"]
            t["signal_since"] = ev["ts"]
            self.advance()
            return True
        if typ == "delay" and t:
            t["delay_min"] += ev.get("minutes", 0)
            if t["status"] == "scheduled":
                t["eta"] = t["planned_arr"] + t["delay_min"] * 60
            self.note("delay", train=t["number"], minutes=ev.get("minutes"))
            return True
        if typ == "track_closed" and ev.get("track") in self.tracks:
            self.closures[ev["track"]] = self.now + ev.get("minutes", 60) * 60
            self.note("track_closed", track=ev["track"], minutes=ev.get("minutes"))
            return True
        if typ == "track_opened":
            self.closures.pop(ev.get("track"), None)
            self.note("track_opened", track=ev.get("track"))
            return True
        if typ == "switch_failure" and ev.get("switch") in self.switch_tracks:
            self.switch_fail[ev["switch"]] = self.now + ev.get("minutes", 45) * 60
            self.note("switch_failure", switch=ev["switch"], minutes=ev.get("minutes"))
            return True
        if typ == "switch_repaired":
            self.switch_fail.pop(ev.get("switch"), None)
            self.note("switch_repaired", switch=ev.get("switch"))
            return True
        if typ == "wagon_defect" and t:
            t["extra_min"] += ev.get("minutes", 30)
            if t["ready"]:
                t["ready"] += ev.get("minutes", 30) * 60
            self.note("wagon_defect", train=t["number"], minutes=ev.get("minutes"))
            return True
        if typ == "resource" and ev.get("resource") in self.caps:
            r = ev["resource"]
            self.caps[r] = max(1, min(20, self.caps[r] + int(ev.get("delta", 0))))
            self.note("resource", resource=r, delta=ev.get("delta"), value=self.caps[r])
            return True
        return False

    # ------------------------------------------------------------ доступность
    def closed_now(self, k):
        return self.closures.get(k, 0) > self.now

    def blocked(self, throat, k, at=None):
        at = self.now if at is None else at
        for sw, until in self.switch_fail.items():
            th, tr = self.switch_tracks[sw]
            if th == throat and k in tr and until > at:
                return until
        return 0

    def occupant(self, k):
        for t in self.trains.values():
            if t["status"] == "on_track" and t["track"] == k:
                return t
        return None

    # ------------------------------------------------------------ исполнение плана
    def advance(self) -> bool:
        changed = False
        for k in list(self.closures):
            if self.closures[k] <= self.now:
                del self.closures[k]
                self.note("track_opened", track=k)
                changed = True
        for sw in list(self.switch_fail):
            if self.switch_fail[sw] <= self.now:
                del self.switch_fail[sw]
                self.note("switch_repaired", switch=sw)
                changed = True
        for t in sorted(self.trains.values(), key=lambda x: x["eta"]):
            p = self.plan.get(t["id"])
            if t["status"] == "on_track" and p:
                ready = self.now >= t["ready"]
                if ready and self.now >= p["dep"] - 30 and not self.blocked(t["to_throat"], t["track"]):
                    if t["kind"] == "passenger" and self.now < t["planned_dep"] - 30:
                        continue
                    t["status"] = "departed"
                    t["actual_dep"] = self.now
                    self.departed.append({"id": t["id"], "kind": t["kind"], "tt_dep": t["planned_dep"],
                                          "tt_arr": t["planned_arr"], "dep": self.now, "arr": t["actual_arr"],
                                          "eta": t.get("eta0", t["eta"]), "signal_since": t.get("signal_since")})
                    self.note("departed", train=t["number"], track=t["track"])
                    changed = True
            elif t["status"] == "waiting_signal" and p:
                k = p["track"]
                if self.now >= p["arr"] - 30 and self.occupant(k) is None and not self.closed_now(k) \
                        and not self.blocked(t["from_throat"], k):
                    t["status"] = "on_track"
                    t["track"] = k
                    t["actual_arr"] = self.now
                    t["eta0"] = t["eta"]
                    t["ready"] = self.now + (t["dwell"] + t["extra_min"]) * 60
                    self.note("arrived", train=t["number"], track=k)
                    changed = True
        # очистка ушедших
        for tid in [i for i, t in self.trains.items() if t["status"] == "departed" and t["actual_dep"] < self.now - 7200]:
            del self.trains[tid]
            self.plan.pop(tid, None)
        return changed

    # ------------------------------------------------------------ активные поезда и ожидаемые времена
    def active(self):
        hz = self.now + self.cfg.planner["horizon_min"] * 60
        return [t for t in self.trains.values()
                if t["status"] != "departed" and (t["status"] in ("on_track", "waiting_signal") or t["eta"] <= hz)]

    def expected(self, t, p):
        if t["status"] == "on_track":
            arr = t["actual_arr"]
            ready = t["ready"]
        else:
            arr = max(p["arr"], t["eta"], self.now)
            ready = arr + (t["dwell"] + t["extra_min"]) * 60
        dep = max(p["dep"], ready)
        if t["kind"] == "passenger":
            dep = max(dep, t["planned_dep"])
        return arr, dep

    # ------------------------------------------------------------ конфликты
    def conflicts(self):
        out = []
        clear = self.station["clear_min"] * 60
        hw = self.station["route_headway_min"] * 60
        exp = {}
        for t in self.active():
            p = self.plan.get(t["id"])
            if not p:
                if t["eta"] - self.now < 3600:
                    out.append({"type": "unplanned", "severity": "warning", "trains": [t["number"]]})
                continue
            exp[t["id"]] = (t, p, *self.expected(t, p))
        for tid, (t, p, a, d) in exp.items():
            k = p["track"]
            if t["status"] != "on_track":
                if self.closures.get(k, 0) > a + 60:
                    out.append({"type": "track_closed", "severity": "critical", "trains": [t["number"]], "track": k})
                if self.blocked(t["from_throat"], k, a + 60):
                    out.append({"type": "route_blocked", "severity": "critical", "trains": [t["number"]], "track": k,
                                "throat": t["from_throat"]})
            if self.blocked(t["to_throat"], k, d + 60):
                out.append({"type": "route_blocked", "severity": "critical", "trains": [t["number"]], "track": k,
                            "throat": t["to_throat"]})
            if t["status"] == "waiting_signal" and self.now > p["arr"] + 120:
                out.append({"type": "waiting_signal", "severity": "warning", "trains": [t["number"]],
                            "minutes": round((self.now - t["signal_since"]) / 60)})
            if t["status"] == "on_track" and self.now > p["dep"] + 60 and self.now < t["ready"]:
                out.append({"type": "not_ready", "severity": "warning", "trains": [t["number"]], "track": k,
                            "minutes": round((t["ready"] - self.now) / 60)})
            late = (d - t["planned_dep"]) / 60
            if late > (5 if t["kind"] == "passenger" else 20):
                out.append({"type": "late", "severity": "info", "trains": [t["number"]], "minutes": round(late)})
        # занятость пути
        by_track: dict[int, list] = {}
        for tid, (t, p, a, d) in exp.items():
            by_track.setdefault(p["track"], []).append((a, d, t))
        for k, lst in by_track.items():
            lst.sort(key=lambda x: x[0])
            for (a1, d1, t1), (a2, d2, t2) in zip(lst, lst[1:]):
                if a2 < d1 + clear - 60:
                    sev = "critical" if "passenger" in (t1["kind"], t2["kind"]) else "warning"
                    out.append({"type": "track_occupied", "severity": sev, "trains": [t1["number"], t2["number"]],
                                "track": k, "minutes": round((d1 + clear - a2) / 60)})
        # враждебные маршруты в горловине
        moves = {"west": [], "east": []}
        for tid, (t, p, a, d) in exp.items():
            if t["status"] != "on_track":
                moves[t["from_throat"]].append((a, t["number"]))
            moves[t["to_throat"]].append((d, t["number"]))
        for th, lst in moves.items():
            lst.sort()
            for (m1, n1), (m2, n2) in zip(lst, lst[1:]):
                if m2 - m1 < hw - 45 and n1 != n2:
                    out.append({"type": "route_crossing", "severity": "warning", "trains": [n1, n2], "throat": th})
        # ресурсы
        for res, mk in (("inspectors", lambda t, a, d: (a, a + INSPECTION_MIN * 60) if t["ops"].get("inspection") else None),
                        ("locos", lambda t, a, d: (d - LOCO_MIN * 60, d) if t["ops"].get("loco_change") else None),
                        ("crews", lambda t, a, d: (d - CREW_MIN * 60, d) if t["ops"].get("crew_change") else None)):
            ivs = []
            for tid, (t, p, a, d) in exp.items():
                iv = mk(t, a, d)
                if iv and iv[1] > self.now:
                    ivs.append((iv[0] + 45, iv[1] - 45, t["number"]))
            pts = sorted({iv[0] for iv in ivs})
            for x in pts:
                cur = [iv for iv in ivs if iv[0] <= x < iv[1]]
                if len(cur) > self.caps[res]:
                    out.append({"type": "shortage", "severity": "warning", "resource": res,
                                "trains": [c[2] for c in cur], "need": len(cur), "have": self.caps[res]})
                    break
        for c in out:
            c["key"] = "|".join([c["type"], *sorted(c["trains"]), str(c.get("track", "")), c.get("resource", "")])
        uniq = {c["key"]: c for c in out}
        order = {"critical": 0, "warning": 1, "info": 2}
        return sorted(uniq.values(), key=lambda c: order[c["severity"]])

    # ------------------------------------------------------------ задача для планировщика
    def problem(self) -> dict:
        trains = []
        for t in self.active():
            p = self.plan.get(t["id"])
            item = {
                "id": t["id"], "number": t["number"], "kind": t["kind"], "length": t["length"], "ops": t["ops"],
                "dwell": t["dwell"] + t["extra_min"], "from_throat": t["from_throat"], "to_throat": t["to_throat"],
                "pd_rel": round((t["planned_dep"] - self.now) / 60), "tt_dep_rel": round((t["planned_dep"] - self.now) / 60),
                "eta_rel": max(0, round((t["eta"] - self.now) / 60)),
                "prev_track": p["track"] if p else None,
                "prev_dep_rel": round((p["dep"] - self.now) / 60) if p else None,
                "buf": round(min(5, self.eta_unc(t) / 2)),  # запас на разброс прибытия
            }
            if t["status"] == "on_track":
                item.update({"on_track": t["track"], "arr_rel": round((t["actual_arr"] - self.now) / 60),
                             "ready_rel": round((t["ready"] - self.now) / 60)})
            elif t["status"] == "waiting_signal":
                item["eta_rel"] = 0
            if not t.get("on_track") and t["status"] != "on_track" and \
                    not allowed_tracks(item, self.station["tracks"], self.cfg.planner["track_penalty"]):
                continue
            trains.append(item)
        blocks = []
        for sw, until in self.switch_fail.items():
            th, trs = self.switch_tracks[sw]
            for k in trs:
                blocks.append({"throat": th, "track": k, "minutes": max(0, round((until - self.now) / 60))})
        return {
            "now": self.now, "horizon": self.cfg.planner["horizon_min"], "tracks": self.station["tracks"],
            "closed": {str(k): max(0, round((v - self.now) / 60)) for k, v in self.closures.items()},
            "blocks": blocks, "caps": dict(self.caps), "trains": trains,
            "headway": self.station["route_headway_min"], "clear": self.station["clear_min"],
        }

    def to_abs(self, problem: dict, result: dict) -> dict:
        base = problem["now"]
        return {tid: {"track": p["track"], "arr": base + p["arr_rel"] * 60, "dep": base + p["dep_rel"] * 60}
                for tid, p in result["plan"].items()}

    # ------------------------------------------------------------ представление для UI
    def eta_unc(self, t):
        """Неопределённость прибытия, мин: растёт с расстоянием до станции."""
        if t["status"] in ("on_track", "departed", "waiting_signal"):
            return 0
        if t["status"] == "scheduled":
            return 5
        return round(1 + 0.06 * max(0, (t["eta"] - self.now) / 60), 1)

    def view_trains(self):
        out = []
        for t in self.trains.values():
            if t["status"] == "departed" and t["actual_dep"] < self.now - 3600:
                continue
            if t["status"] == "scheduled" and t["eta"] > self.now + 4 * 3600:
                continue
            p = self.plan.get(t["id"])
            exp = self.expected(t, p) if p and t["status"] != "departed" else (None, None)
            out.append({
                "id": t["id"], "number": t["number"], "kind": t["kind"], "from": t["from"], "to": t["to"],
                "length": t["length"], "status": t["status"], "km": t["km"], "eta": t["eta"],
                "planned_arr": t["planned_arr"], "planned_dep": t["planned_dep"],
                "plan_track": p["track"] if p else None, "plan_arr": p["arr"] if p else None,
                "plan_dep": p["dep"] if p else None, "exp_arr": exp[0], "exp_dep": exp[1],
                "track": t["track"], "actual_arr": t["actual_arr"], "actual_dep": t["actual_dep"],
                "ready": t["ready"], "ops": t["ops"], "dwell": t["dwell"] + t["extra_min"], "eta_unc": self.eta_unc(t),
                "delay_min": round(((exp[1] or t.get("actual_dep") or t["planned_dep"]) - t["planned_dep"]) / 60),
            })
        return out
