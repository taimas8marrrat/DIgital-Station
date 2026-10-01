"""Симулятор движения и ресурсов станции. Шлёт поток событий по WebSocket (2 Гц по умолчанию).
Специально добавляет шум координат, дубликаты и битые сообщения — чтобы показать валидацию на входе.
Запуск: python -m simulator.sim --url ws://localhost:8000/ws/ingest
"""
import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import websockets  # noqa: E402

from app import config  # noqa: E402
from app.timetable import instances, parse_sim_start, set_load  # noqa: E402

logging.basicConfig(level="INFO", format='{"ts":"%(asctime)s","level":"%(levelname)s","svc":"simulator","msg":"%(message)s"}')
log = logging.getLogger("sim")
APPROACH_MIN = 40
SPEED_KMH = 80


class World:
    def __init__(self, start, speed, seed=7, noise=True, random_incidents=True):
        self.now = start
        self.speed = speed
        self.rnd = random.Random(seed)
        self.noise = noise
        self.random_incidents = random_incidents
        self.trains = {}
        self.loaded_until = start
        self.pending = []
        self._load()

    def _load(self):
        end = self.now + 6 * 3600
        for t in instances(self.loaded_until, end):
            r = self.rnd.random()
            dev = self.rnd.uniform(-2, 2) if r < 0.7 else (self.rnd.uniform(5, 15) if r < 0.9 else -5)
            t["true_arr"] = t["planned_arr"] + dev * 60
            t["signaled"] = False
            self.trains[t["id"]] = t
        self.loaded_until = end

    def ev(self, typ, **kw):
        return {"id": uuid.uuid4().hex[:12], "ts": self.now, "type": typ, "sent_wall_ms": time.time() * 1000, **kw}

    def control(self, msg):
        if msg.get("cmd") == "reset":
            set_load(float(msg.get("load", 1)))
            self.__init__(parse_sim_start(config.SIM_START), self.speed, noise=self.noise, random_incidents=False)
            log.info("reset load=%s", msg.get("load", 1))
            return
        if msg.get("cmd") == "speed":
            self.speed = float(msg["factor"])
            log.info("speed=%s", self.speed)
        elif msg.get("cmd") == "incident":
            e = dict(msg["event"])
            if e["type"] == "delay":
                t = self.trains.get(e.get("train"))
                if not t or t["signaled"]:
                    return
                t["true_arr"] += e.get("minutes", 0) * 60
            e["ts"] = self.now
            e["sent_wall_ms"] = time.time() * 1000
            self.pending.append(e)

    def tick(self, dt):
        self.now += self.speed * dt
        if self.now > self.loaded_until - 5 * 3600:
            self._load()
        out = [self.ev("clock", speed_factor=self.speed)]
        out += self.pending
        self.pending = []
        for t in list(self.trains.values()):
            left = (t["true_arr"] - self.now) / 60
            if t["signaled"]:
                if t["true_arr"] < self.now - 6 * 3600:
                    del self.trains[t["id"]]
                continue
            if left <= 0:
                t["signaled"] = True
                out.append(self.ev("at_signal", train=t["id"]))
            elif left <= APPROACH_MIN:
                km = left * SPEED_KMH / 60
                if self.noise:
                    km = max(0.1, km + self.rnd.gauss(0, 0.4))
                out.append(self.ev("position", train=t["id"], km=round(km, 2), speed=SPEED_KMH))
        if self.random_incidents and self.rnd.random() < 0.004 * self.speed * dt:
            far = [t for t in self.trains.values() if not t["signaled"] and (t["true_arr"] - self.now) > 1800]
            if far:
                t = self.rnd.choice(far)
                m = self.rnd.choice([10, 15, 20])
                t["true_arr"] += m * 60
                out.append(self.ev("delay", train=t["id"], minutes=m, reason="random"))
        if self.noise:
            if self.rnd.random() < 0.03 and len(out) > 1:
                out.append(dict(self.rnd.choice(out)))       # дубликат
            if self.rnd.random() < 0.01:
                out.append({"id": "bad", "type": "position"})  # битое сообщение
        return out


async def run(url, hz, speed, start):
    world = World(start, speed, noise=os.getenv("SIM_NOISE", "true") == "true",
                  random_incidents=os.getenv("SIM_RANDOM_INCIDENTS", "false") == "true")
    backoff = 0.5
    while True:
        try:
            async with websockets.connect(url, max_size=2 ** 22) as ws:
                log.info("connected %s", url)
                backoff = 0.5

                async def rx():
                    async for m in ws:
                        world.control(json.loads(m))

                rx_task = asyncio.create_task(rx())
                dt = 1.0 / hz
                nxt = time.perf_counter()
                try:
                    while True:
                        await ws.send(json.dumps(world.tick(dt), ensure_ascii=False))
                        nxt += dt
                        await asyncio.sleep(max(0, nxt - time.perf_counter()))
                finally:
                    rx_task.cancel()
        except Exception as e:  # reconnect с экспоненциальной паузой
            log.warning("no connection (%s), retry in %.1fs", e.__class__.__name__, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.getenv("INGEST_URL", "ws://localhost:8000/ws/ingest"))
    ap.add_argument("--hz", type=float, default=config.SIM_TICK_HZ)
    ap.add_argument("--speed", type=float, default=config.SIM_SPEED)
    a = ap.parse_args()
    asyncio.run(run(a.url, a.hz, a.speed, parse_sim_start(config.SIM_START)))
