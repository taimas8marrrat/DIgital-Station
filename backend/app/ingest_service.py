"""Отдельный сервис приёма данных (режим Docker): WS /ws/ingest -> нормализация -> Redis Streams."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse

from . import config, metrics
from .bus import make_bus
from .ingest import IngestService

logging.basicConfig(level=config.LOG_LEVEL,
                    format='{"ts":"%(asctime)s","level":"%(levelname)s","svc":"ingest","logger":"%(name)s","msg":"%(message)s"}')
bus = make_bus(config.BUS, config.REDIS_URL)
svc = IngestService(bus)


@asynccontextmanager
async def lifespan(app):
    await bus.start()
    await svc.start()
    yield


app = FastAPI(title="Ingest service", lifespan=lifespan)
app.include_router(svc.router)


@app.get("/health")
async def health():
    return {"status": "ok" if await bus.ping() else "degraded", "sources": len(svc.sources),
            "buffer": svc.buffer.qsize()}


@app.get("/metrics", response_class=PlainTextResponse)
async def m():
    return metrics.render()
