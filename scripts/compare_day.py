"""Пакетное сравнение «вручную / цифровая станция» на одних и тех же сутках и сбоях.
Запуск из корня репозитория:  python scripts/compare_day.py --runs 10
Оба способа получают одинаковое расписание, одинаковые отклонения прибытия и одинаковые нештатные ситуации.
"""
import argparse
import json
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(ROOT))
from app.config import CFG, TIMETABLE  # noqa: E402
from app.planner import solve  # noqa: E402
from app.timetable import parse_sim_start  # noqa: E402
from app.twin import Twin  # noqa: E402
from simulator.sim import World  # noqa: E402

DAY = 86400
N_INC = 10
STEP = 60          # шаг модели, с
REPLAN = 600       # перепланирование раз в 10 минут модели


def incidents(seed, start):
    rnd = random.Random(seed)
    out = []
    for _ in range(N_INC):  # нештатные ситуации за сутки
        at = start + rnd.randint(3600, DAY - 3 * 3600)
        r = rnd.random()
        if r < 0.45:
            out.append((at, {"type": "delay", "minutes": rnd.choice([15, 25, 40])}))
        elif r < 0.65:
            out.append((at, {"type": "track_closed", "track": rnd.choice([2, 3, 4, 5]), "minutes": rnd.choice([45, 90])}))
        elif r < 0.8:
            out.append((at, {"type": "switch_failure", "switch": rnd.choice(["W3", "E3", "E2", "W2"]), "minutes": 40}))
        elif r < 0.9:
            out.append((at, {"type": "wagon_defect", "minutes": 30}))
        else:
            out.append((at, {"type": "resource", "resource": rnd.choice(["inspectors", "crews"]), "delta": -1}))
    return sorted(out, key=lambda x: x[0])


def run(seed, mode, start):
    world = World(start, 1.0, seed=seed, noise=False, random_incidents=False)
    tw = Twin(CFG)
    plan_cfg = dict(CFG.planner, time_limit_s=0.5)
    inc = incidents(seed, start)
    pick = random.Random(seed * 7)
    next_plan = start
    solve_ms = []
    while world.now < start + DAY:
        while inc and inc[0][0] <= world.now:
            _, e = inc.pop(0)
            e = dict(e)
            if e["type"] == "delay":
                cand = sorted(t["id"] for t in world.trains.values() if not t["signaled"] and t["true_arr"] - world.now > 1800)
                if not cand:
                    continue
                e["train"] = pick.choice(cand)
            if e["type"] == "wagon_defect":
                cand = sorted(t["id"] for t in tw.trains.values() if t["status"] == "on_track")
                if not cand:
                    continue
                e["train"] = pick.choice(cand)
            world.control({"cmd": "incident", "event": {"id": f"i{seed}{world.now}", **e}})
        for ev in world.tick(STEP):
            tw.apply(ev)
        if world.now >= next_plan:
            prob = tw.problem()
            res = solve(prob, plan_cfg, "optimal" if mode == "smart" else "manual")
            solve_ms.append(res["solve_ms"])
            tw.plan = tw.to_abs(prob, res)
            tw.advance()
            next_plan = world.now + REPLAN
    dep = [d for d in tw.departed if d["tt_dep"] >= start]
    late = [max(0, d["dep"] - d["tt_dep"]) / 60 for d in dep]
    on_time = sum(1 for x in late if x <= 5) / max(1, len(late)) * 100
    # по вине станции = опоздание отправления минус опоздание подхода к входному сигналу
    by_station = [max(0, (d["dep"] - d["tt_dep"]) - max(0, (d.get("signal_since") or d["arr"]) - d["tt_arr"])) / 3600 for d in dep]
    wait = [max(0, d["arr"] - d["signal_since"]) / 60 for d in dep if d.get("signal_since")]
    dwell = [(d["dep"] - d["arr"]) / 3600 for d in dep if d["kind"] != "passenger"]
    return {"departed": len(dep), "on_time_pct": on_time, "station_delay_train_h": sum(by_station),
            "total_delay_min": sum(late), "wait_signal_min": sum(wait),
            "transit_dwell_h": statistics.mean(dwell) if dwell else 0, "solve_ms_avg": statistics.mean(solve_ms)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--rate", type=float, default=None, help="условная стоимость поездо-часа простоя, тенге")
    ap.add_argument("--load", type=float, default=1.0, help="рост потока грузовых: 1.0 — текущий, 2.0 — вдвое больше")
    ap.add_argument("--incidents", type=int, default=10)
    ap.add_argument("--out", default="compare_results.json")
    a = ap.parse_args()
    global N_INC
    N_INC = a.incidents
    if a.load > 1:
        extra, fr = [], [t for t in TIMETABLE["trains"] if t["kind"] != "passenger"]
        rnd = random.Random(5)
        for t in rnd.sample(fr, int(len(fr) * (a.load - 1))):
            c = dict(t); sh = rnd.randint(15, 25)
            c["id"] = t["id"] + "x"; c["number"] = str(int(t["number"]) + 1000)
            c["arr"] = (t["arr"] + sh) % 1440; c["dep"] = c["arr"] + (t["dep"] - t["arr"])
            extra.append(c)
        TIMETABLE["trains"] = sorted(TIMETABLE["trains"] + extra, key=lambda x: x["arr"])
    start = parse_sim_start("2026-10-01T00:00:00")
    rows = []
    t0 = time.time()
    for seed in range(1, a.runs + 1):
        m, s = run(seed, "manual", start), run(seed, "smart", start)
        rows.append({"seed": seed, "manual": m, "smart": s})
        print(f"сценарий {seed}: задержка по вине станции {m['station_delay_train_h']:.1f} → {s['station_delay_train_h']:.1f} поездо-ч,"
              f" график {m['on_time_pct']:.0f}% → {s['on_time_pct']:.0f}%", flush=True)
    keys = rows[0]["manual"].keys()
    summary = {}
    for k in keys:
        mv = [r["manual"][k] for r in rows]
        sv = [r["smart"][k] for r in rows]
        summary[k] = {"manual_mean": statistics.mean(mv), "smart_mean": statistics.mean(sv),
                      "manual_sd": statistics.pstdev(mv), "smart_sd": statistics.pstdev(sv)}
    sd = summary["station_delay_train_h"]
    gain = (1 - sd["smart_mean"] / sd["manual_mean"]) * 100 if sd["manual_mean"] else 0
    out = {"runs": a.runs, "load": a.load, "incidents_per_day": a.incidents, "trains_per_day": len(TIMETABLE["trains"]), "summary": summary, "station_delay_reduction_pct": gain, "rows": rows,
           "elapsed_s": round(time.time() - t0)}
    if a.rate:
        out["money_saved_per_day_kzt"] = (sd["manual_mean"] - sd["smart_mean"]) * a.rate
    path = Path(__file__).resolve().parents[1] / "docs" / a.out
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: {kk: round(vv, 2) for kk, vv in v.items()} for k, v in summary.items()}, ensure_ascii=False, indent=1))
    print(f"Снижение задержек по вине станции: {gain:.0f}%   ({out['elapsed_s']} с)  -> {path}")


if __name__ == "__main__":
    main()
