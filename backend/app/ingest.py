"""Приём и нормализация потока: валидация, дедупликация, порядок, сглаживание, буфер."""
import asyncio
import json
import logging
import time
from collections import OrderedDict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import metrics
from .models import Event

log = logging.getLogger("ingest")


class Normalizer:
    def __init__(self, ema_alpha: float = 0.4):
        self.seen: OrderedDict[str, None] = OrderedDict()
        self.last_ts: dict[str, float] = {}
        self.km: dict[str, float] = {}
        self.alpha = ema_alpha

    def process(self, raw) -> dict | None:
        metrics.inc("ingest_received")
        try:
            ev = Event.model_validate(raw)
        except ValidationError:
            metrics.inc("ingest_invalid")
            return None
        if ev.id in self.seen:
            metrics.inc("ingest_duplicates")
            return None
        self.seen[ev.id] = None
        if len(self.seen) > 20000:
            self.seen.popitem(last=False)
        if ev.type == "position" and ev.train:
            if ev.ts < self.last_ts.get(ev.train, 0):
                metrics.inc("ingest_out_of_order")
                return None
            self.last_ts[ev.train] = ev.ts
            prev = self.km.get(ev.train)
            if ev.km is not None:
                sm = ev.km if prev is None or ev.km > prev + 5 else self.alpha * ev.km + (1 - self.alpha) * prev
                self.km[ev.train] = sm
                ev.km = round(sm, 2)
        d = ev.model_dump(exclude_none=True)
        d["recv_wall_ms"] = time.time() * 1000
        metrics.inc("ingest_accepted")
        return d


class IngestService:
    """WS-приёмник от симулятора/внешних систем. Нормализованные события -> шина 'events'.
    Команды для симулятора берутся из шины 'control' и отправляются обратно по тому же каналу."""

    def __init__(self, bus):
        self.bus = bus
        self.norm = Normalizer()
        self.buffer: asyncio.Queue = asyncio.Queue(maxsize=50000)
        self.sources: set[WebSocket] = set()
        self.router = APIRouter()
        self.router.add_api_websocket_route("/ws/ingest", self.ws_ingest)
        self.tasks = []

    async def start(self):
        self.tasks.append(asyncio.create_task(self._drain()))
        ctrl = await self.bus.subscribe("control")
        self.tasks.append(asyncio.create_task(self._control(ctrl)))

    async def _drain(self):
        while True:
            raw = await self.buffer.get()
            ev = self.norm.process(raw)
            if ev:
                await self.bus.publish("events", ev)
            metrics.gauge("ingest_buffer", self.buffer.qsize())

    async def _control(self, q):
        while True:
            msg = await q.get()
            if msg.get("cmd") == "reset":
                self.norm = Normalizer()  # время модели начинается заново — сбросить проверку порядка
            dead = []
            for ws in list(self.sources):
                try:
                    await ws.send_text(json.dumps(msg, ensure_ascii=False))
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.sources.discard(ws)
            if not self.sources and msg.get("cmd") == "incident":
                # симулятор не подключён — событие идёт напрямую через нормализацию
                ev = dict(msg["event"])
                await self.buffer.put(ev)

    async def push(self, raw):
        if self.buffer.full():
            metrics.inc("ingest_dropped_overflow")
            return
        await self.buffer.put(raw)

    async def ws_ingest(self, ws: WebSocket):
        await ws.accept()
        self.sources.add(ws)
        metrics.gauge("ingest_sources", len(self.sources))
        log.info("source connected")
        await self.bus.publish("events", {"type": "_source", "connected": True, "ts": 0})
        try:
            while True:
                txt = await ws.receive_text()
                try:
                    data = json.loads(txt)
                except json.JSONDecodeError:
                    metrics.inc("ingest_invalid")
                    continue
                for raw in data if isinstance(data, list) else [data]:
                    await self.push(raw)
        except WebSocketDisconnect:
            pass
        finally:
            self.sources.discard(ws)
            metrics.gauge("ingest_sources", len(self.sources))
            await self.bus.publish("events", {"type": "_source", "connected": False, "ts": 0})
            log.info("source disconnected")
