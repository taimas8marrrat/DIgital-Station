"""Оркестратор: события из шины -> двойник -> конфликты -> планировщик -> рассылка в UI -> история."""
from __future__ import annotations

import asyncio
import concurrent.futures as cf
import json
import logging
import random
import time
import uuid

from . import index as index_mod
from . import metrics
from .planner import plan_kpi, solve
from .twin import Twin

log = logging.getLogger("engine")
_POOL = None


def _pool():
    global _POOL
    if _POOL is None:
        import multiprocessing
        from concurrent.futures import ProcessPoolExecutor
        # spawn: одинаково на Windows и Linux, дочерний процесс не наследует сокеты сервера
        _POOL = ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context("spawn"))
    return _POOL


def _reset_pool():
    global _POOL
    try:
        if _POOL:
            _POOL.shutdown(wait=False, cancel_futures=True)
    except Exception:
        pass
    _POOL = None
ACTIONABLE = {"track_closed", "route_blocked", "track_occupied", "route_crossing", "shortage", "waiting_signal",
              "not_ready"}


class Engine:
    def __init__(self, bus, storage, cfg):
        self.bus = bus
        self.storage = storage
        self.cfg = cfg
        self.twin = Twin(cfg)
        self.clients: set = set()
        self.conflicts: list = []
        self.proposal: dict | None = None
        self.compare: dict | None = None
        self.index: dict | None = None
        self.dirty = True
        self.solving = False
        self.last_roll = 0.0
        self.last_src_ms = None
        self.sim_connected = False
        self.last_event_wall = 0.0
        self.event_buf: list = []
        self.tasks: list = []
        self.dismissed: set = set()
        self.accepted_sig = None
        self.incident_window_until = 0.0
        self.autopilot = False
        self.autopilot_delay = 2.5
        self.last_incident_wall = 0.0
        self.last_resolve = None
        self.last_roll_sim = 0.0
        # умная скорость: спокойно — быстро, при сбое — замедление
        self.auto_speed = True
        self.calm_speed = 288.0
        self.slow_speed = 10.0
        self.manual_speed = 30.0
        self.slow_hold_until = 0.0
        self.sent_speed = None

    def reset(self, load: float = 1.0):
        """Демо заново: двойник и план с нуля (время модели вернёт симулятор)."""
        from .timetable import set_load
        set_load(load)
        self.twin = Twin(self.cfg)
        self.conflicts, self.proposal, self.compare = [], None, None
        self.dirty, self.accepted_sig, self.last_resolve = True, None, None
        self.dismissed = set()
        self.autopilot, self.auto_speed, self.sent_speed = False, True, None
        self.last_roll = self.last_roll_sim = 0.0
        self.incident_window_until = self.slow_hold_until = 0.0
        self.load = load

    async def start(self):
        # прогрев процесса решателя, чтобы первый план не ждал запуска OR-Tools
        asyncio.create_task(self._run({"now": 0, "horizon": 60, "tracks": [], "closed": {}, "blocks": [], "caps": {},
                                       "trains": [], "headway": 2, "clear": 3}, "optimal"))
        q = await self.bus.subscribe("events")
        self.tasks += [asyncio.create_task(self._speed_loop())]
        self.tasks += [asyncio.create_task(self._consume(q)), asyncio.create_task(self._plan_loop()),
                       asyncio.create_task(self._broadcast_loop()), asyncio.create_task(self._persist_loop())]

    def target_speed(self):
        if not self.auto_speed:
            return self.manual_speed
        return self.slow_speed if (self.proposal or time.time() < self.slow_hold_until) else self.calm_speed

    async def _speed_loop(self):
        """Плавно меняет скорость симулятора командами по шине."""
        cur = None
        while True:
            await asyncio.sleep(0.25)
            tgt = self.target_speed()
            cur = tgt if cur is None else (tgt if abs(tgt - cur) < 1 else cur + (tgt - cur) * (0.6 if tgt < cur else 0.25))
            if self.sent_speed is None or abs(cur - self.sent_speed) >= 0.5:
                self.sent_speed = cur
                await self.bus.publish("control", {"cmd": "speed", "factor": round(cur, 1)})

    def mark_incident(self):
        now = time.time()
        self.slow_hold_until = now + 4
        self.incident_window_until = now + 30
        self.last_incident_wall = now
        self.last_resolve = None

    def disaster_events(self, kind):
        tw = self.twin
        up = lambda dirs: [t for t in tw.trains.values() if t["status"] in ("scheduled", "approaching") and t["from"] in dirs]
        evs = []
        if kind == "derail":
            evs += [{"type": "track_closed", "track": 3, "minutes": 90}, {"type": "switch_failure", "switch": "E2", "minutes": 90},
                    {"type": "switch_failure", "switch": "E3", "minutes": 90}, {"type": "resource", "resource": "inspectors", "delta": -1}]
        elif kind == "storm":
            evs += [{"type": "delay", "train": t["id"], "minutes": 25 + random.randint(0, 20)} for t in up(["east"])[:4]]
            evs += [{"type": "delay", "train": t["id"], "minutes": 15} for t in up(["north"])[:2]]
            evs.append({"type": "resource", "resource": "crews", "delta": -1})
        else:
            evs += [{"type": "switch_failure", "switch": s, "minutes": 40} for s in ("W1", "W2", "W3")]
        tw.note("disaster", dk=kind)
        return evs

    # ---------------------------------------------------------------- события
    async def _consume(self, q):
        while True:
            ev = await q.get()
            try:
                if ev.get("type") == "_source":
                    self.sim_connected = ev["connected"]
                    continue
                self.last_event_wall = time.time()
                if ev.get("sent_wall_ms"):
                    self.last_src_ms = ev["sent_wall_ms"]
                if self.twin.apply(ev):
                    self.dirty = True
                if ev["type"] not in ("clock", "position"):
                    self.event_buf.append(ev)
                metrics.inc("engine_events")
            except Exception:
                log.exception("event failed: %s", ev)

    # ---------------------------------------------------------------- планирование
    async def _plan_loop(self):
        while True:
            await asyncio.sleep(0.25)
            if self.twin.now is None or self.solving:
                continue
            try:
                self.conflicts = self.twin.conflicts()
                # мелкие отклонения план поправляет сам; карточка ДСП — при критичном конфликте или после нештатной ситуации
                after_inc = time.time() < self.incident_window_until
                actionable = [c for c in self.conflicts if c["type"] in ACTIONABLE and c["key"] not in self.dismissed
                              and (c["severity"] == "critical" or after_inc)]
                sig = "|".join(sorted(c["key"] for c in actionable))
                need_roll = time.time() - self.last_roll > self.cfg.planner["rolling_replan_s"] or \
                    (self.twin.now - self.last_roll_sim) > 600 or any(c["type"] == "unplanned" for c in self.conflicts)
                if self.autopilot and self.proposal and time.time() - self.proposal["created_wall"] >= self.autopilot_delay:
                    n = len(self.proposal["conflicts"])
                    if self.accept(self.proposal["id"], self.proposal["recommended"], "auto") and self.last_incident_wall:
                        self.last_resolve = {"sec": round(time.time() - self.last_incident_wall, 1), "at": time.time() * 1000, "conflicts": n}
                    continue
                if sig and sig == self.accepted_sig:
                    actionable = []  # уже решено принятым планом — уточняем плановым обновлением
                if actionable and (self.proposal is None or self.proposal["signature"] != sig) and \
                        (self.dirty or self.proposal is None):
                    await self._make_proposal(actionable, sig)
                elif not actionable and (self.dirty or need_roll):
                    self.proposal = None
                    await self._roll()
                elif actionable and self.proposal and self.cfg.planner.get("auto_apply"):
                    self.accept(self.proposal["id"], self.proposal["recommended"], "auto")
                self.dirty = False
            except Exception:
                log.exception("plan loop")
                self.solving = False

    async def _run(self, problem, mode):
        """CP-SAT считается в отдельном процессе: даже аварийное падение решателя не роняет сервер.
        При сбое процесса — резервная эвристика в основном процессе."""
        cfg = dict(self.cfg.planner)
        if mode in ("manual", "heuristic") or not self.cfg.planner.get("isolate_solver", True):
            return await asyncio.to_thread(solve, problem, cfg, mode)
        loop = asyncio.get_running_loop()
        try:
            return await asyncio.wait_for(loop.run_in_executor(_pool(), solve, problem, cfg, mode),
                                          timeout=cfg["time_limit_s"] + 5)
        except Exception as e:  # BrokenProcessPool, таймаут, падение OR-Tools
            log.warning("solver process failed (%s) -> heuristic fallback", e.__class__.__name__)
            _reset_pool()
            metrics.inc("planner_solver_failures")
            res = await asyncio.to_thread(solve, problem, cfg, "heuristic")
            res["method"] = mode
            res["fallback"] = True
            return res

    async def _roll(self):
        """Плановое обновление без конфликтов: минимум изменений, применяется автоматически."""
        self.solving = True
        try:
            prob = self.twin.problem()
            smart = await self._run(prob, "minimal")
            manual = await self._run(prob, "manual")
            self._commit(prob, smart, "rolling")
            self._set_compare(prob, smart, manual)
            self.last_roll = time.time()
            self.last_roll_sim = self.twin.now
        finally:
            self.solving = False

    async def _make_proposal(self, actionable, sig):
        self.solving = True
        try:
            t0 = time.perf_counter()
            prob = self.twin.problem()
            results = await asyncio.gather(self._run(prob, "optimal"), self._run(prob, "minimal"),
                                           self._run(prob, "heuristic"), self._run(prob, "manual"))
            variants = []
            for res in results[:3]:
                plan_abs = self.twin.to_abs(prob, res)
                idx = index_mod.compute(self.twin, [], self.cfg, plan=plan_abs)
                variants.append({
                    "id": res["method"], "solver": res["solver"], "status": res["status"],
                    "solve_ms": res["solve_ms"], "fallback": res.get("fallback", False),
                    "kpi": plan_kpi(prob, res), "index": idx["value"], "category": idx["category"],
                    "plan": plan_abs, "changes": self._changes(plan_abs),
                })
            best = max(variants, key=lambda v: (v["index"], -v["kpi"]["total_delay_min"]))
            self.proposal = {"id": uuid.uuid4().hex[:8], "created": self.twin.now, "signature": sig,
                             "conflicts": actionable, "variants": variants, "recommended": best["id"],
                             "total_ms": round((time.perf_counter() - t0) * 1000), "created_wall": time.time(),
                             "createdWall": time.time() * 1000}
            self._set_compare(prob, next(r for r in results if r["method"] == "optimal"), results[3])
            metrics.inc("planner_proposals")
            metrics.gauge("planner_last_ms", self.proposal["total_ms"])
            log.info("proposal %s: %d conflicts, %d ms", self.proposal["id"], len(actionable), self.proposal["total_ms"])
            if self.cfg.planner.get("auto_apply"):
                self.accept(self.proposal["id"], best["id"], "auto")
        finally:
            self.solving = False

    def _changes(self, plan_abs):
        out = []
        for tid, p in plan_abs.items():
            old = self.twin.plan.get(tid)
            t = self.twin.trains.get(tid)
            if not t:
                continue
            if not old or old["track"] != p["track"] or abs(old["dep"] - p["dep"]) >= 120 or abs(old["arr"] - p["arr"]) >= 120:
                out.append({"train": t["number"], "kind": t["kind"],
                            "track_from": old["track"] if old else None, "track_to": p["track"],
                            "arr_from": old["arr"] if old else None, "arr_to": p["arr"],
                            "dep_from": old["dep"] if old else None, "dep_to": p["dep"]})
        out.sort(key=lambda c: c["arr_to"])
        return out

    def _set_compare(self, prob, smart, manual):
        ks, km = plan_kpi(prob, smart), plan_kpi(prob, manual)
        pa = self.twin.to_abs(prob, manual)
        self.compare = {"smart": ks, "manual": km,
                        "smart_index": index_mod.compute(self.twin, [], self.cfg, plan=self.twin.to_abs(prob, smart))["value"],
                        "manual_index": index_mod.compute(self.twin, [], self.cfg, plan=pa)["value"]}

    def _commit(self, prob, res, by):
        self.twin.plan = self.twin.to_abs(prob, res)
        v = self.twin.plan_meta.get("version", 0) + 1
        self.twin.plan_meta = {"version": v, "method": res["method"], "solver": res["solver"], "status": res["status"],
                               "solve_ms": res["solve_ms"], "by": by, "sim_ts": self.twin.now}
        self.twin.advance()
        try:
            self.storage.write_plan(self.twin.now, res["method"], res["solve_ms"], by, self.twin.plan)
        except Exception:
            log.exception("write plan")

    def accept(self, pid, variant_id, by):
        if not self.proposal or self.proposal["id"] != pid:
            return False
        v = next((v for v in self.proposal["variants"] if v["id"] == variant_id), None)
        if not v:
            return False
        self.twin.plan = v["plan"]
        ver = self.twin.plan_meta.get("version", 0) + 1
        self.twin.plan_meta = {"version": ver, "method": v["id"], "solver": v["solver"], "status": v["status"],
                               "solve_ms": v["solve_ms"], "by": by, "sim_ts": self.twin.now}
        self.twin.note("plan_accepted", variant=v["id"], by=by, changes=len(v["changes"]))
        self.twin.advance()
        try:
            self.storage.write_plan(self.twin.now, v["id"], v["solve_ms"], by, v["plan"])
        except Exception:
            log.exception("write plan")
        self.accepted_sig = self.proposal["signature"]
        self.proposal = None
        self.dirty = True
        metrics.inc("planner_accepted")
        return True

    def reject(self, pid, by):
        if self.proposal and self.proposal["id"] == pid:
            for c in self.proposal["conflicts"]:
                self.dismissed.add(c["key"])
            self.twin.note("plan_rejected", by=by)
            self.proposal = None
            return True
        return False

    # ---------------------------------------------------------------- вид для UI
    def kpi(self):
        """Отраслевые показатели за последние 24 ч модели."""
        tw = self.twin
        now = tw.now
        dep = [d for d in tw.departed if d["dep"] >= now - 86400]
        late = [max(0, d["dep"] - d["tt_dep"]) / 60 for d in dep]
        on_time = (sum(1 for x in late if x <= 5) / len(dep) * 100) if dep else None
        st = sum(max(0, (d["dep"] - d["tt_dep"]) - max(0, (d.get("signal_since") or d["arr"]) - d.get("tt_arr", d["arr"]))) / 3600
                 for d in dep)
        fr = [d for d in dep if d["kind"] != "passenger"]
        dwell = sum((d["dep"] - d["arr"]) / 3600 for d in fr) / len(fr) if fr else None
        rate = self.cfg.index["params"].get("delay_cost_kzt_per_train_hour")
        return {"departed": len(dep), "on_time_pct": on_time, "station_delay_train_h": st, "transit_dwell_h": dwell,
                "rate": rate, "cost_kzt": st * rate if rate else None}

    def view(self, with_proposal=True):
        tw = self.twin
        if tw.now is None:
            return {"type": "state", "ready": False, "sim_connected": self.sim_connected}
        self.index = index_mod.compute(tw, self.conflicts, self.cfg)
        prop = None
        if with_proposal and self.proposal:
            prop = {k: v for k, v in self.proposal.items() if k != "variants"}
            prop["variants"] = [{k: v for k, v in var.items() if k != "plan"} | {"plan": {
                tid: p for tid, p in var["plan"].items()}} for var in self.proposal["variants"]]
        return {
            "type": "state", "ready": True, "now": tw.now, "speed": tw.speed, "wall_ms": time.time() * 1000,
            "src_wall_ms": self.last_src_ms, "sim_connected": self.sim_connected,
            "stream_age_s": round(time.time() - self.last_event_wall, 1) if self.last_event_wall else None,
            "tracks": [{"id": k, "occupant": (tw.occupant(k) or {}).get("number"),
                        "closed_until": tw.closures.get(k)} for k in tw.tracks],
            "switches": [{"id": s, "failed_until": tw.switch_fail.get(s)} for s in tw.switch_tracks],
            "trains": tw.view_trains(), "plan_meta": tw.plan_meta, "conflicts": self.conflicts,
            "proposal": prop, "index": self.index, "kpi": self.kpi(), "compare": self.compare, "caps": tw.caps,
            "load": getattr(self, "load", 1.0), "auto": self.auto_speed, "target_speed": self.target_speed(), "autopilot": self.autopilot,
            "autopilot_ms": self.autopilot_delay * 1000, "last_resolve": self.last_resolve,
            "log": list(tw.log)[:25],
            "ingest": {k: metrics.COUNTERS.get(f"ingest_{k}", 0) for k in
                       ("received", "accepted", "duplicates", "invalid", "out_of_order")},
        }

    async def _broadcast_loop(self):
        while True:
            await asyncio.sleep(0.25)
            if not self.clients:
                continue
            msg = json.dumps(self.view(), ensure_ascii=False, default=str)
            dead = []
            for ws in list(self.clients):
                try:
                    await asyncio.wait_for(ws.send_text(msg), timeout=1.0)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)
            metrics.gauge("ui_clients", len(self.clients))

    async def _persist_loop(self):
        n = 0
        while True:
            await asyncio.sleep(5)
            n += 1
            try:
                if self.twin.now is not None:
                    v = self.view(with_proposal=False)
                    await asyncio.to_thread(self.storage.write_snapshot, self.twin.now, v["index"]["value"],
                                            v["index"]["category"], v)
                buf, self.event_buf = self.event_buf, []
                await asyncio.to_thread(self.storage.write_events, buf)
                if n % 120 == 0:
                    await asyncio.to_thread(self.storage.purge)
            except Exception:
                log.exception("persist")

    # ---------------------------------------------------------------- нагрузочный сценарий
    def stress_events(self, n=10):
        tw = self.twin
        rnd = random.Random()
        upcoming = [t for t in tw.trains.values() if t["status"] in ("scheduled", "approaching")]
        on_track = [t for t in tw.trains.values() if t["status"] == "on_track"]
        evs = []
        for i in range(n):
            r = rnd.random()
            if r < 0.45 and upcoming:
                evs.append({"type": "delay", "train": rnd.choice(upcoming)["id"], "minutes": rnd.choice([10, 15, 25, 40])})
            elif r < 0.6:
                evs.append({"type": "track_closed", "track": rnd.choice([2, 4, 5]), "minutes": rnd.choice([30, 60])})
            elif r < 0.7:
                evs.append({"type": "switch_failure", "switch": rnd.choice(["W3", "E3", "E1"]), "minutes": 30})
            elif r < 0.85 and on_track:
                evs.append({"type": "wagon_defect", "train": rnd.choice(on_track)["id"], "minutes": 30})
            else:
                evs.append({"type": "resource", "resource": rnd.choice(["inspectors", "crews"]), "delta": -1})
        return evs
