"""Настройки из переменных окружения (.env). Секреты — только здесь."""
import json
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:  # noqa
    pass

BASE = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("DATA_DIR", BASE / "data"))
CONFIG_DIR = Path(os.getenv("CONFIG_DIR", BASE / "config"))
STATIC_DIR = Path(os.getenv("STATIC_DIR", BASE.parent / "frontend" / "dist"))
FONT_DIR = BASE / "fonts"

BUS = os.getenv("BUS", "memory")                 # memory | redis
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
DB_URL = os.getenv("DB_URL", f"sqlite:///{BASE / 'digital_station.db'}")
EMBED_INGEST = os.getenv("EMBED_INGEST", "true").lower() == "true"

AUTH_SECRET = os.getenv("AUTH_SECRET", "change-me-in-env")
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")
DISPATCHER_USER = os.getenv("DISPATCHER_USER", "dsp")
DISPATCHER_PASSWORD = os.getenv("DISPATCHER_PASSWORD", "dsp")

SIM_SPEED = float(os.getenv("SIM_SPEED", "30"))      # сим-секунд на 1 реальную секунду
SIM_TICK_HZ = float(os.getenv("SIM_TICK_HZ", "4"))   # частота потока, Гц
SIM_START = os.getenv("SIM_START", "2026-10-01T11:20:00")
HISTORY_HOURS = int(os.getenv("HISTORY_HOURS", "72"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


STATION = load_json(DATA_DIR / "station.json")
RESOURCES = load_json(DATA_DIR / "resources.json")
TIMETABLE = load_json(DATA_DIR / "timetable.json")


class LiveConfig:
    """Конфигурация индекса и планировщика, перечитывается без перезапуска."""

    def __init__(self):
        self.index = load_json(CONFIG_DIR / "index.json")
        self.planner = load_json(CONFIG_DIR / "planner.json")

    def update(self, name: str, data: dict):
        cur = getattr(self, name)
        merged = _deep_merge(cur, data)
        setattr(self, name, merged)
        save_json(CONFIG_DIR / f"{name}.json", merged)
        return merged


def _deep_merge(a, b):
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


CFG = LiveConfig()
