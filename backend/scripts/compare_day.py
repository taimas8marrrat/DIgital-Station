"""Пакетное сравнение «вручную» и «цифровая станция» на одинаковых сутках и одинаковых сбоях.
Запуск: cd backend && python -m scripts.compare_day --runs 10
Ручной режим: очередь по времени прибытия, первый свободный путь, 5 мин на реакцию при конфликте.
Цифровая станция: CP-SAT, перепланирование каждые 10 минут модели и сразу после сбоя."""
import argparse
import json
import random
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import CFG  # noqa: E402
from app.planner import solve  # noqa: E402
from app.timetable import parse_sim_start  # noqa: E402
from app.twin import Twin  # noqa: E402
from simulator.sim import World  # noqa: E402


def incidents(seed, start, hours):
    r = random.Random(seed)
    out = []
    for _ in range(int(hours * 0.75)):              # ~18 сбоев за сутки
        at = start + r.uniform(0.5, hours) * 3600
        k = r.random()
        if k < 0.45:
            out.append((at, {"type": "delay_any", "minutes": r.choice([10, 15, 25, 40])}))
        elif k < 0.65:
            out.append((at, {"type": "track_closed", "track": r.choice([2, 3, 4, 5]), "minutes": r.choice([30, 60, 90])}))
        elif k < 0.8:
            out.append((at, {"type": "switch_failure", "switch": r.choice(["W3", "E3", "E1", "W2"]), "minutes": r.choice([30, 45])}))
        elif k < 0.9:
            out.append((at, {"type": "wagon_defect_any", "minutes": 30}))
        else:
            out.append((at, {"type": "resource", "resource": r.choice(["inspectors", "crews"]), "delta": -1}))
    return sorted(out, key=lambda x: x[0])


def run(policy, seed, hours=24, dt=60):
    cfg = dict(CFG.planner)
    cfg["time_limit_s"] = 1.0
    start = parse_sim_start("2026-10-01T05:00:00")
    world = World(start, speed=1, seed=seed, noise=False, random_incidents=False)
    tw = Twin(CFG)
    incs = incidents(seed * 7 + 1, start, hours)
    r = random.Random(seed)
    last_plan, pending_replan, lag_until = 0, True, 0
    end = start + hours * 3600
    while world.now < end:
        while incs and incs[0][0] <= world.now:
            _, e = incs.pop(0)
            e = dict(e)
            if e["type"] == "delay_any":
                cand = [t for t in world.trains.values() if not t["signaled"] and t["true_arr"] - world.now > 600]
                if not cand:
                    continue
                e = {"type": "delay", "train": r.choice(cand)["id"], "minutes": e["minutes"]}
            if e["type"] == "wagon_defect_any":
                cand = [t for t in tw.trains.values() if t["status"] == "on_track"]
                if not cand:
                    continue
                e = {"type": "wagon_defect", "train": r.choice(cand)["id"], "minutes": e["minutes"]}
            world.control({"cmd": "incident", "event": {"id": "x", **e}})
            pending_replan = True
            if policy == "manual":
                lag_until = world.now + cfg["manual_reaction_lag_min"] * 60
        for ev in world.tick(dt):
            if ev.get("type") and ev.get("ts"):
                tw.apply(ev)
        if tw.now is None:
            continue
        due = (pending_replan and world.now >= lag_until) or world.now - last_plan >= 600
        if due:
            prob = tw.problem()
            res = solve(prob, cfg, "optimal" if policy == "smart" else "manual")
            tw.plan = tw.to_abs(prob, res)
            tw.advance()
            last_plan, pending_replan = world.now, False
    deps = [d for d in tw.departed if d["tt_dep"] >= start + 3600]
    delay = sum(max(0, (d["dep"] - d["tt_dep"]) / 60) for d in deps)
    pas = sum(max(0, (d["dep"] - d["tt_dep"]) / 60) for d in deps if d["kind"] == "passenger")
    return {"departed": len(deps), "delay_min": round(delay), "passenger_delay_min": round(pas),
            "avg_delay_min": round(delay / max(1, len(deps)), 1)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--hours", type=float, default=24)
    a = ap.parse_args()
    rows = []
    for s in range(1, a.runs + 1):
        m, sm = run("manual", s, a.hours), run("smart", s, a.hours)
        rows.append({"seed": s, "manual": m, "smart": sm})
        print(s, m, sm, flush=True)
    def agg(key, pol):
        v = [r[pol][key] for r in rows]
        return round(statistics.mean(v), 1), round(statistics.pstdev(v), 1)
    summary = {k: {"manual": agg(k, "manual"), "smart": agg(k, "smart")} for k in ("delay_min", "passenger_delay_min", "avg_delay_min", "departed")}
    gain = [1 - r["smart"]["delay_min"] / r["manual"]["delay_min"] for r in rows if r["manual"]["delay_min"]]
    summary["delay_reduction_pct"] = (round(100 * statistics.mean(gain)), round(100 * statistics.pstdev(gain)))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    (Path(__file__).parent / "compare_result.json").write_text(json.dumps({"runs": rows, "summary": summary}, ensure_ascii=False, indent=1), encoding="utf-8")
