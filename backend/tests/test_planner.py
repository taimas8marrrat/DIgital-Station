"""Проверки планировщика: запуск  cd backend && python -m pytest -q"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import CFG, STATION  # noqa: E402
from app.planner import plan_kpi, solve  # noqa: E402


def train(i, kind="freight", eta=0, pd=60, length=900, frm="east", to="west", **ops):
    o = {"stop": 20, "inspection": kind == "freight", "loco_change": False, "crew_change": True} | ops
    dwell = max(o["stop"], 40 if o["inspection"] else 0, 15 if o["crew_change"] else 0)
    return {"id": f"T{i}", "number": str(i), "kind": kind, "length": length, "ops": o, "dwell": dwell,
            "from_throat": frm, "to_throat": to, "eta_rel": eta, "pd_rel": pd, "tt_dep_rel": pd,
            "prev_track": None, "prev_dep_rel": None}


def problem(trains, closed=None, blocks=None, caps=None):
    return {"now": 0, "horizon": 240, "tracks": STATION["tracks"], "closed": closed or {}, "blocks": blocks or [],
            "caps": caps or {"inspectors": 3, "locos": 4, "crews": 6}, "trains": trains, "headway": 2, "clear": 3}


def occupancy_ok(prob, res):
    by = {}
    for tid, p in res["plan"].items():
        by.setdefault(p["track"], []).append((p["arr_rel"], p["dep_rel"] + prob["clear"]))
    for ivs in by.values():
        ivs.sort()
        for (a1, d1), (a2, _) in zip(ivs, ivs[1:]):
            if a2 < d1:
                return False
    return True


def test_no_track_overlap_and_specialisation():
    trs = [train(i, eta=i * 3) for i in range(8)] + [train(100, "passenger", eta=10, pd=30, length=450, frm="west", to="east")]
    prob = problem(trs)
    res = solve(prob, CFG.planner, "optimal")
    assert res["solver"] == "CP-SAT"
    assert occupancy_ok(prob, res)
    assert res["plan"]["T100"]["track"] in (1, 2)          # пассажирский — только к платформе
    for i in range(8):
        assert res["plan"][f"T{i}"]["track"] in (3, 4, 5)   # грузовые — не на пассажирские пути


def test_closed_track_respected():
    trs = [train(i, eta=0) for i in range(2)]
    res = solve(problem(trs, closed={"4": 120, "5": 120}), CFG.planner, "optimal")
    for p in res["plan"].values():
        assert p["track"] == 3 or p["arr_rel"] >= 120


def test_switch_failure_blocks_route():
    trs = [train(1, eta=0, frm="west", to="east")]
    blocks = [{"throat": "west", "track": 4, "minutes": 60}, {"throat": "west", "track": 5, "minutes": 60}]
    res = solve(problem(trs, blocks=blocks), CFG.planner, "optimal")
    p = res["plan"]["T1"]
    assert p["track"] == 3 or p["arr_rel"] >= 60


def test_resource_limit():
    trs = [train(i, eta=0, pd=45) for i in range(3)]
    res = solve(problem(trs, caps={"inspectors": 1, "locos": 4, "crews": 6}), CFG.planner, "optimal")
    deps = sorted(p["dep_rel"] for p in res["plan"].values())
    assert deps[-1] >= 3 * 40  # одна бригада осмотрщиков — осмотры последовательно


def test_smart_not_worse_than_manual():
    trs = [train(i, eta=i * 4, pd=i * 4 + 50) for i in range(10)] + \
          [train(200 + i, "passenger", eta=i * 15, pd=i * 15 + 20, length=450, frm="west", to="east") for i in range(3)]
    prob = problem(trs, closed={"4": 60})
    smart = plan_kpi(prob, solve(prob, CFG.planner, "optimal"))
    manual = plan_kpi(prob, solve(prob, CFG.planner, "manual"))
    assert smart["total_delay_min"] <= manual["total_delay_min"]


def test_solve_time_under_5s():
    trs = [train(i, eta=i * 2, pd=i * 2 + 60) for i in range(40)]
    res = solve(problem(trs), CFG.planner, "optimal")
    assert res["solve_ms"] < 5000
