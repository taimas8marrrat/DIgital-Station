"""Индекс эффективности станции (0–100) с прозрачной формулой и вкладом факторов."""
from __future__ import annotations

FACTORS = ["throughput", "adherence", "conflicts", "track_load", "idle"]


def _clamp(x):
    return max(0.0, min(100.0, x))


def category(value, thr):
    if value >= thr["norm"]:
        return "norm"
    if value >= thr["attention"]:
        return "attention"
    return "critical"


def compute(twin, conflicts, cfg, plan=None, problem=None):
    """plan=None — текущее состояние; plan задан — прогноз индекса для варианта плана."""
    P = cfg.index["params"]
    W = cfg.index["weights"]
    now = twin.now
    plan = plan if plan is not None else twin.plan
    detail = {}

    # 1. Пропускная способность: отправлено за 60 мин / по графику за 60 мин
    dep_last = [d for d in twin.departed if d["dep"] >= now - 3600]
    due = sum(1 for d in twin.departed if now - 3600 <= d["tt_dep"] <= now) + \
        sum(1 for t in twin.trains.values() if t["status"] != "departed" and now - 3600 <= t["planned_dep"] <= now)
    ratio = 1.0 if due == 0 else min(1.0, len(dep_last) / due)
    detail["throughput"] = (_clamp(100 * ratio), {"done": len(dep_last), "due": due})

    # 2. Соблюдение графика: среднее отклонение отправления от графика, мин
    devs = []
    for t in twin.active():
        p = plan.get(t["id"])
        if p:
            _, d = twin.expected(t, p)
            devs.append(max(0, (d - t["planned_dep"]) / 60))
    devs += [max(0, (d["dep"] - d["tt_dep"]) / 60) for d in dep_last]
    avg = sum(devs) / len(devs) if devs else 0
    detail["adherence"] = (_clamp(100 - P["adherence_penalty_per_min"] * avg), {"avg_min": round(avg, 1)})

    # 3. Конфликты
    crit = sum(1 for c in conflicts if c["severity"] == "critical")
    warn = sum(1 for c in conflicts if c["severity"] == "warning")
    detail["conflicts"] = (_clamp(100 - P["conflict_penalty_critical"] * crit - P["conflict_penalty_warning"] * warn),
                           {"critical": crit, "warning": warn})

    # 4. Загрузка путей: средняя доля занятых/закрытых путей на ближайшие 60 мин
    n = len(twin.tracks)
    samples = []
    for step in range(0, 3600, 600):
        tm = now + step
        busy = set(k for k, until in twin.closures.items() if until > tm)
        for t in twin.active():
            p = plan.get(t["id"])
            if p:
                a, d = twin.expected(t, p)
                if a <= tm < d:
                    busy.add(p["track"])
        samples.append(len(busy) / n)
    u = sum(samples) / len(samples)
    ideal = P["track_load_ideal"]
    detail["track_load"] = (_clamp(100 if u <= ideal else 100 - (u - ideal) / (1 - ideal) * 100),
                            {"load_pct": round(u * 100)})

    # 5. Простой: ожидание у входного сигнала и сверх готовности (мин на поезд)
    idle = []
    for t in twin.active():
        p = plan.get(t["id"])
        if t["status"] == "waiting_signal":
            wait_until = p["arr"] if p else now + 1800
            idle.append(max(0, (max(now, wait_until) - t["signal_since"]) / 60))
        elif t["status"] == "on_track" and p:
            idle.append(max(0, (max(p["dep"], now) - max(t["ready"], t["planned_dep"] if t["kind"] == "passenger" else 0)) / 60) if now > t["ready"] else 0)
        elif p:
            idle.append(max(0, (p["arr"] - t["eta"]) / 60))
    avg_idle = sum(idle) / len(idle) if idle else 0
    detail["idle"] = (_clamp(100 - P["idle_penalty_per_min"] * avg_idle), {"avg_min": round(avg_idle, 1)})

    value = sum(W[f] * detail[f][0] for f in FACTORS)
    factors = [{"id": f, "score": round(detail[f][0]), "weight": W[f],
                "contribution": round(W[f] * detail[f][0], 1), "loss": round(W[f] * (100 - detail[f][0]), 1),
                "params": detail[f][1]} for f in FACTORS]
    factors.sort(key=lambda x: -x["loss"])
    return {"value": round(value), "category": category(value, cfg.index["thresholds"]), "factors": factors,
            "thresholds": cfg.index["thresholds"]}
