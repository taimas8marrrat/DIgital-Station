"""Запуск без Docker (запасной режим): один процесс core + симулятор, SQLite, встроенная шина.
Использование:  python run.py   ->  http://localhost:8000
"""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
PORT = int(os.getenv("PORT", "8000"))
env = {**os.environ, "BUS": os.getenv("BUS", "memory"), "EMBED_INGEST": "true",
       "PYTHONPATH": str(BACKEND), "PYTHONIOENCODING": "utf-8"}

core = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", str(PORT)],
                        cwd=BACKEND, env=env)
for _ in range(60):
    try:
        urllib.request.urlopen(f"http://localhost:{PORT}/health", timeout=1)
        break
    except Exception:
        time.sleep(0.5)
sim = subprocess.Popen([sys.executable, "-m", "simulator.sim", "--url", f"ws://localhost:{PORT}/ws/ingest"],
                       cwd=BACKEND, env=env)
print(f"\n  Цифровая станция запущена: http://localhost:{PORT}   (API: /docs)\n  Остановить: Ctrl+C\n", flush=True)
try:
    core.wait()
except KeyboardInterrupt:
    pass
finally:
    sim.terminate()
    core.terminate()
