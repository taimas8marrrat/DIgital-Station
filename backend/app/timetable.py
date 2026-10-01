"""Развёртка суточного расписания в экземпляры поездов на абсолютной шкале (сим-секунды, UTC)."""
from datetime import datetime, timezone

import random

from .config import TIMETABLE

BASE_TRAINS = list(TIMETABLE["trains"])


def set_load(factor: float = 1.0):
    """Рост потока грузовых: factor 1.6 добавляет 60 % поездов со сдвигом 15–25 мин (детерминированно)."""
    trains = list(BASE_TRAINS)
    if factor > 1:
        fr = [t for t in BASE_TRAINS if t["kind"] != "passenger"]
        rnd = random.Random(5)
        for t in rnd.sample(fr, int(len(fr) * (factor - 1))):
            c = dict(t)
            sh = rnd.randint(15, 25)
            c["id"] = t["id"] + "x"
            c["number"] = str(int(t["number"]) + 1000)
            c["arr"] = (t["arr"] + sh) % 1440
            c["dep"] = c["arr"] + (t["dep"] - t["arr"])
            trains.append(c)
    TIMETABLE["trains"] = sorted(trains, key=lambda x: x["arr"])


def day_start(sim_ts: float) -> float:
    return sim_ts - (sim_ts % 86400)


def dwell_min(ops: dict) -> int:
    return max(ops.get("stop", 0), 40 if ops.get("inspection") else 0,
               30 if ops.get("loco_change") else 0, 15 if ops.get("crew_change") else 0)


def instances(t_from: float, t_to: float):
    """Все поезда с плановым прибытием в окне [t_from, t_to)."""
    out = []
    d0 = day_start(t_from) - 86400
    while d0 < t_to:
        day = datetime.fromtimestamp(d0, tz=timezone.utc).strftime("%m%d")
        for tr in TIMETABLE["trains"]:
            arr = d0 + tr["arr"] * 60
            if t_from <= arr < t_to:
                inst = dict(tr)
                inst["id"] = f"{tr['id']}-{day}"
                inst["planned_arr"] = arr
                inst["planned_dep"] = d0 + tr["dep"] * 60
                inst["dwell"] = dwell_min(tr["ops"])
                out.append(inst)
        d0 += 86400
    out.sort(key=lambda x: x["planned_arr"])
    return out


def parse_sim_start(s: str) -> float:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()
