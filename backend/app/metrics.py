"""Простые метрики сервиса в формате Prometheus."""
import time
from collections import defaultdict

COUNTERS: dict[str, float] = defaultdict(float)
GAUGES: dict[str, float] = {}
STARTED = time.time()


def inc(name, v=1.0):
    COUNTERS[name] += v


def gauge(name, v):
    GAUGES[name] = v


def render() -> str:
    lines = [f"ds_uptime_seconds {time.time() - STARTED:.0f}"]
    for k, v in sorted(COUNTERS.items()):
        lines.append(f"ds_{k}_total {v:g}")
    for k, v in sorted(GAUGES.items()):
        lines.append(f"ds_{k} {v:g}")
    return "\n".join(lines) + "\n"
