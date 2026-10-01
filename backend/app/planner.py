"""Модуль ИИ-планирования станции.

Вход — «задача» (dict), выход — план (dict). Модуль не зависит от остального кода,
поэтому его можно вынести в отдельный сервис/процесс без изменений.

Методы:
  * optimal  — CP-SAT (OR-Tools): назначение путей + очерёдность + ресурсы, минимум взвешенных задержек;
  * minimal  — CP-SAT с высоким штрафом за изменение ранее назначенных путей (минимум переделок);
  * heuristic — жадная эвристика по приоритету (резерв, если решатель не уложился в лимит);
  * manual   — модель ручной работы: «первый пришёл — первый обслужен», первый свободный путь,
               задержка реакции диспетчера. Используется только для сравнения «До / После».
"""
from __future__ import annotations

import time
from typing import Any

from ortools.sat.python import cp_model

INSPECTION_MIN = 40
LOCO_MIN = 30
CREW_MIN = 15


# ---------------------------------------------------------------- допустимые пути
def allowed_tracks(train: dict, tracks: list[dict], penalties: dict) -> dict[int, int]:
    """Возвращает {путь: штраф}. Учитывает специализацию путей и полезную длину."""
    out: dict[int, int] = {}
    kind = train["kind"]
    nonstop = train["ops"].get("stop", 0) <= 2
    for tr in tracks:
        if train["length"] > tr["length"]:
            continue
        if kind == "passenger":
            if nonstop and tr["kind"] in ("passenger", "main"):
                out[tr["id"]] = 0
            elif tr["kind"] == "passenger" and tr.get("platform"):
                out[tr["id"]] = 0
        else:
            if tr["kind"] == "passenger":
                continue  # грузовые на пассажирские пути не принимаются (специализация)
            if tr["kind"] == "main":
                out[tr["id"]] = 0 if nonstop else penalties.get("freight_on_main", 5)
            else:
                pen = penalties.get("through_on_side", 3) if nonstop else 0
                if kind == "container" and not nonstop:
                    pen += penalties.get("container_on_freight", 1)
                out[tr["id"]] = pen
    return out


def _weight(train, cfg):
    return cfg["priority_weight"].get(train["kind"], 2)


# ---------------------------------------------------------------- CP-SAT
def solve_cpsat(problem: dict, cfg: dict, mode: str = "optimal") -> dict | None:
    t0 = time.perf_counter()
    m = cp_model.CpModel()
    H = int(problem["horizon"]) + 400
    h = problem["headway"]
    clear = problem["clear"]
    closed = {int(k): v for k, v in problem["closed"].items()}
    blocks = {(b["throat"], b["track"]): b["minutes"] for b in problem["blocks"]}
    caps = problem["caps"]
    stab_w = cfg["stability_weight"].get(mode, 1)

    track_iv: dict[int, list] = {tr["id"]: [] for tr in problem["tracks"]}
    throat_iv: dict[str, list] = {"west": [], "east": []}
    res_iv: dict[str, list] = {"inspectors": [], "locos": [], "crews": []}
    obj = []
    V: dict[str, dict] = {}

    for t in problem["trains"]:
        w = _weight(t, cfg)
        pd = int(t["pd_rel"])
        dwell = int(t["dwell"])
        tid = t["id"]
        if t.get("on_track"):
            k = t["on_track"]
            lo = max(0, int(t["ready_rel"]))
            if t["kind"] == "passenger":
                lo = max(lo, pd)
            lo = max(lo, blocks.get((t["to_throat"], k), 0))
            d = m.NewIntVar(lo, H, f"d_{tid}")
            occ = m.NewIntervalVar(0, d + clear, d + clear, f"occ_{tid}")
            track_iv[k].append(occ)
            a = None
            x = {k: None}
        else:
            eta = int(t["eta_rel"])
            allowed = allowed_tracks(t, problem["tracks"], cfg["track_penalty"])
            if not allowed:
                continue
            a = m.NewIntVar(eta, H, f"a_{tid}")
            d = m.NewIntVar(0, H + 200, f"d_{tid}")
            m.Add(d >= a + dwell)
            if t["kind"] == "passenger":
                m.Add(d >= pd)
            x = {}
            for k, pen in allowed.items():
                xb = m.NewBoolVar(f"x_{tid}_{k}")
                x[k] = xb
                end = m.NewIntVar(0, H + 300, f"e_{tid}_{k}")
                m.Add(end == d + clear).OnlyEnforceIf(xb)
                size = m.NewIntVar(0, H + 300, f"s_{tid}_{k}")
                buf = int(t.get("buf", 0))  # запас на разброс прибытия: путь занят чуть раньше расчётного
                iv = m.NewOptionalIntervalVar(a - buf, size, end, xb, f"o_{tid}_{k}")
                track_iv[k].append(iv)
                if k in closed:
                    m.Add(a >= int(closed[k])).OnlyEnforceIf(xb)
                rb = blocks.get((t["from_throat"], k))
                if rb:
                    m.Add(a >= int(rb)).OnlyEnforceIf(xb)
                rb = blocks.get((t["to_throat"], k))
                if rb:
                    m.Add(d >= int(rb)).OnlyEnforceIf(xb)
                if pen:
                    obj.append(pen * xb)
                prev = t.get("prev_track")
                if prev is not None and prev != k:
                    obj.append(stab_w * xb)
            m.AddExactlyOne(x.values())
            throat_iv[t["from_throat"]].append(m.NewIntervalVar(a, h, a + h, f"ta_{tid}"))
            if t["ops"].get("inspection"):
                s = m.NewIntVar(eta, H, f"insp_{tid}")
                m.Add(s >= a)
                m.Add(s + INSPECTION_MIN <= d)
                res_iv["inspectors"].append(m.NewIntervalVar(s, INSPECTION_MIN, s + INSPECTION_MIN, f"ri_{tid}"))
            obj.append(int(round(cfg["wait_weight"] * w * 10)) * (a - eta))
        throat_iv[t["to_throat"]].append(m.NewIntervalVar(d, h, d + h, f"td_{tid}"))
        if t["ops"].get("loco_change"):
            res_iv["locos"].append(m.NewIntervalVar(d - LOCO_MIN, LOCO_MIN, d, f"rl_{tid}"))
        if t["ops"].get("crew_change"):
            res_iv["crews"].append(m.NewIntervalVar(d - CREW_MIN, CREW_MIN, d, f"rc_{tid}"))
        L = m.NewIntVar(0, H + 400, f"L_{tid}")
        m.Add(L >= d - pd)
        obj.append(w * 10 * L)
        if mode == "minimal" and t.get("prev_dep_rel") is not None:
            dev = m.NewIntVar(0, H + 400, f"dev_{tid}")
            m.AddAbsEquality(dev, d - int(t["prev_dep_rel"]))
            obj.append(5 * dev)
        V[tid] = {"a": a, "d": d, "x": x, "train": t}

    for k, ivs in track_iv.items():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)
    for th, ivs in throat_iv.items():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)
    for r, ivs in res_iv.items():
        if ivs:
            m.AddCumulative(ivs, [1] * len(ivs), max(1, int(caps.get(r, 1))))

    # тёплый старт по предыдущему плану
    for tid, v in V.items():
        t = v["train"]
        if v["a"] is not None and t.get("prev_track") in v["x"]:
            for k, xb in v["x"].items():
                m.AddHint(xb, k == t["prev_track"])
    m.Minimize(sum(obj))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(cfg["time_limit_s"])
    solver.parameters.num_search_workers = int(cfg.get("workers", 8))
    st = solver.Solve(m)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    plan = {}
    for tid, v in V.items():
        t = v["train"]
        if v["a"] is None:
            k = t["on_track"]
            arr = t["arr_rel"]
        else:
            k = next(k for k, xb in v["x"].items() if solver.Value(xb))
            arr = solver.Value(v["a"])
        plan[tid] = {"track": k, "arr_rel": arr, "dep_rel": solver.Value(v["d"])}
    return {
        "method": mode,
        "solver": "CP-SAT",
        "status": "OPTIMAL" if st == cp_model.OPTIMAL else "FEASIBLE",
        "solve_ms": round((time.perf_counter() - t0) * 1000, 1),
        "plan": plan,
    }


# ---------------------------------------------------------------- эвристика / ручной режим
def solve_greedy(problem: dict, cfg: dict, manual: bool = False) -> dict:
    t0 = time.perf_counter()
    H = int(problem["horizon"]) + 1200
    h = problem["headway"]
    clear = problem["clear"]
    closed = {int(k): v for k, v in problem["closed"].items()}
    blocks = {(b["throat"], b["track"]): b["minutes"] for b in problem["blocks"]}
    caps = problem["caps"]
    lag = cfg.get("manual_reaction_lag_min", 5)
    track_free = {tr["id"]: 0 for tr in problem["tracks"]}
    moves = {"west": [], "east": []}
    usage = {r: [0] * (H + 2000) for r in ("inspectors", "locos", "crews")}

    def throat_ok(th, tm):
        return all(abs(tm - x) >= h for x in moves[th])

    def res_ok(r, s, e):
        s = max(0, s)
        return all(usage[r][i] < max(1, caps.get(r, 1)) for i in range(s, max(s, e)))

    def res_take(r, s, e):
        for i in range(max(0, s), max(0, e)):
            usage[r][i] += 1

    def find_dep(t, d, k):
        lim = d + 1500
        while d < lim:
            if d >= blocks.get((t["to_throat"], k), 0) and throat_ok(t["to_throat"], d) and \
                    (not t["ops"].get("loco_change") or res_ok("locos", d - LOCO_MIN, d)) and \
                    (not t["ops"].get("crew_change") or res_ok("crews", d - CREW_MIN, d)):
                return d
            d += 1
        return d

    def commit_dep(t, d):
        moves[t["to_throat"]].append(d)
        if t["ops"].get("loco_change"):
            res_take("locos", d - LOCO_MIN, d)
        if t["ops"].get("crew_change"):
            res_take("crews", d - CREW_MIN, d)

    plan = {}
    trains = problem["trains"]
    for t in [t for t in trains if t.get("on_track")]:
        k = t["on_track"]
        d = max(0, int(t["ready_rel"]))
        if t["kind"] == "passenger":
            d = max(d, int(t["pd_rel"]))
        d = find_dep(t, d, k)
        commit_dep(t, d)
        track_free[k] = d + clear
        plan[t["id"]] = {"track": k, "arr_rel": t["arr_rel"], "dep_rel": d}

    rest = [t for t in trains if not t.get("on_track")]
    if manual:
        rest.sort(key=lambda t: t["eta_rel"])
    else:
        rest.sort(key=lambda t: (-_weight(t, cfg), t["eta_rel"]))
    for t in rest:
        allowed = allowed_tracks(t, problem["tracks"], cfg["track_penalty"])
        if not allowed:
            continue
        order = sorted(allowed)
        if manual and t.get("prev_track") in allowed:
            order.remove(t["prev_track"])
            order.insert(0, t["prev_track"])
        best = None
        for k in order:
            eta = int(t["eta_rel"])
            a = max(eta, track_free[k] + int(t.get("buf", 0)), int(closed.get(k, 0)), blocks.get((t["from_throat"], k), 0))
            lim = a + 1500
            while a < lim:
                if throat_ok(t["from_throat"], a) and (
                        not t["ops"].get("inspection") or res_ok("inspectors", a, a + INSPECTION_MIN)):
                    break
                a += 1
            if manual and a > eta:
                a += lag  # диспетчер замечает конфликт и перестраивает маршрут не мгновенно
            d = a + int(t["dwell"])
            if t["kind"] == "passenger":
                d = max(d, int(t["pd_rel"]))
            d = find_dep(t, d, k)
            cost = _weight(t, cfg) * max(0, d - t["pd_rel"]) + allowed[k] + (a - eta)
            if manual:
                # ручной режим: первый свободный путь (раньше всех можно принять), при равенстве — специализированный
                cost = (a, allowed[k], 0 if k == t.get("prev_track") else 1)
            if best is None or cost < best[0]:
                best = (cost, k, a, d)
        _, k, a, d = best
        moves[t["from_throat"]].append(a)
        if t["ops"].get("inspection"):
            res_take("inspectors", a, a + INSPECTION_MIN)
        commit_dep(t, d)
        track_free[k] = d + clear
        plan[t["id"]] = {"track": k, "arr_rel": a, "dep_rel": d}
    return {
        "method": "manual" if manual else "heuristic",
        "solver": "greedy",
        "status": "FEASIBLE",
        "solve_ms": round((time.perf_counter() - t0) * 1000, 1),
        "plan": plan,
    }


# ---------------------------------------------------------------- KPI плана
def plan_kpi(problem: dict, result: dict) -> dict[str, Any]:
    by_id = {t["id"]: t for t in problem["trains"]}
    total = pas = mx = wait = changed = 0
    for tid, p in result["plan"].items():
        t = by_id[tid]
        late = max(0, p["dep_rel"] - t["tt_dep_rel"])
        total += late
        mx = max(mx, late)
        if t["kind"] == "passenger":
            pas += late
        if not t.get("on_track"):
            wait += max(0, p["arr_rel"] - t["eta_rel"])
            if t.get("prev_track") is not None and t["prev_track"] != p["track"]:
                changed += 1
    n = max(1, len(result["plan"]))
    return {"total_delay_min": round(total), "passenger_delay_min": round(pas), "max_delay_min": round(mx),
            "avg_delay_min": round(total / n, 1), "wait_at_signal_min": round(wait), "changed_tracks": changed,
            "trains": len(result["plan"])}


def solve(problem: dict, cfg: dict, mode: str = "optimal") -> dict:
    """Точка входа: CP-SAT с резервом на эвристику."""
    if mode == "manual":
        return solve_greedy(problem, cfg, manual=True)
    if mode == "heuristic":
        return solve_greedy(problem, cfg)
    res = solve_cpsat(problem, cfg, mode)
    if res is None:
        res = solve_greedy(problem, cfg)
        res["fallback"] = True
    return res
