"""Генератор суточного расписания (mock), откалиброван по открытым данным КТЖ:
~37 грузовых/контейнерных поездов в сутки на участке Достык — Мойынты (сент. 2025 — янв. 2026),
пассажирские маршруты через Актогай: Алматы↔Семей, Астана↔Семей, Достык↔Алматы.
Запуск: python data/generate_timetable.py [--pairs N] [--seed S]
"""
import argparse, json, random
from pathlib import Path

PASSENGER_ROUTES = [
    ("Алматы — Семей", "Алматы — Семей", "south", "north"),
    ("Семей — Алматы", "Семей — Алматы", "north", "south"),
    ("Астана — Семей", "Астана — Семей", "west", "north"),
    ("Семей — Астана", "Семей — Астана", "north", "west"),
    ("Достык — Алматы", "Достық — Алматы", "east", "south"),
    ("Алматы — Достык", "Алматы — Достық", "south", "east"),
]
FREIGHT_FLOWS = [  # (from, to, kind, weight)
    ("east", "west", "container", 0.30),   # КНР → Мойынты (транзит Китай — Европа)
    ("west", "east", "freight", 0.22),     # порожние/экспорт на Достык
    ("east", "south", "freight", 0.12),
    ("south", "east", "freight", 0.08),
    ("south", "north", "freight", 0.14),
    ("north", "south", "freight", 0.14),
]


def generate(freight_per_day=37, seed=42):
    rnd = random.Random(seed)
    trains = []
    # Пассажирские: 10 в сутки
    for i in range(10):
        r = PASSENGER_ROUTES[i % len(PASSENGER_ROUTES)]
        arr = (i * 140 + rnd.randint(0, 60)) % 1430
        stop = rnd.choice([15, 20, 25])
        trains.append({
            "id": f"P{101 + i}", "number": str(101 + i),
            "kind": "passenger", "route": {"ru": r[0], "kk": r[1]},
            "from": r[2], "to": r[3], "length": rnd.choice([350, 420, 480, 540]),
            "arr": arr % 1440, "dep": arr + stop,
            "ops": {"stop": stop, "inspection": False, "loco_change": i % 3 == 0, "crew_change": True},
        })
    # Грузовые и контейнерные
    weights = [f[3] for f in FREIGHT_FLOWS]
    for i in range(freight_per_day):
        f = rnd.choices(FREIGHT_FLOWS, weights)[0]
        arr = rnd.randint(0, 1440 - 1)
        if f[2] == "container":
            through = rnd.random() < 0.35
            ops = {"stop": 2 if through else 15, "inspection": False, "loco_change": False, "crew_change": not through}
            length = rnd.choice([780, 850, 900, 950])
        else:
            ops = {"stop": 20, "inspection": True, "loco_change": rnd.random() < 0.5, "crew_change": True}
            length = rnd.choice([700, 820, 900, 980, 1040])
        dwell = max(ops["stop"], 40 if ops["inspection"] else 0, 30 if ops["loco_change"] else 0,
                    15 if ops["crew_change"] else 0)
        num = 2000 + i * 2 + (1 if f[0] in ("west", "north") else 0)
        trains.append({
            "id": f"F{num}", "number": str(num), "kind": f[2],
            "from": f[0], "to": f[1], "length": length,
            "arr": arr, "dep": arr + dwell + rnd.randint(0, 15), "ops": ops,
        })
    trains.sort(key=lambda t: t["arr"])
    return {"_note": "Mock-расписание. Время — минуты от начала суток. Сгенерировано generate_timetable.py",
            "seed": seed, "trains": trains}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--freight", type=int, default=37)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    out = Path(__file__).parent / "timetable.json"
    out.write_text(json.dumps(generate(a.freight, a.seed), ensure_ascii=False, indent=1), encoding="utf-8")
    print("written", out)
