"""Core-сервис: цифровой двойник, ИИ-планирование, индекс, REST/WS API, UI."""
import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, metrics, report
from .bus import make_bus
from .engine import Engine
from .ingest import IngestService
from .models import IncidentRequest
from .storage import Storage

logging.basicConfig(level=config.LOG_LEVEL,
                    format='{"ts":"%(asctime)s","level":"%(levelname)s","svc":"core","logger":"%(name)s","msg":"%(message)s"}')
log = logging.getLogger("core")

bus = make_bus(config.BUS, config.REDIS_URL)
storage = Storage(config.DB_URL, config.HISTORY_HOURS)
engine = Engine(bus, storage, config.CFG)
ingest = IngestService(bus) if config.EMBED_INGEST else None


@asynccontextmanager
async def lifespan(app):
    await bus.start()
    await asyncio.to_thread(storage.init)
    if ingest:
        await ingest.start()
    await engine.start()
    log.info("started bus=%s db=%s embedded_ingest=%s", bus.name, storage.kind, bool(ingest))
    if config.AUTH_SECRET.startswith("change-me") or config.ADMIN_PASSWORD == "admin":
        log.warning("ВНИМАНИЕ: пароли или секрет по умолчанию. Для эксплуатации задайте ADMIN_PASSWORD, DISPATCHER_PASSWORD и AUTH_SECRET в .env")
    yield


app = FastAPI(title="Цифровая станция Актогай API", version="1.0.0", lifespan=lifespan,
              description="Планирование работы станции с ИИ: цифровой двойник, CP-SAT планировщик, индекс эффективности.")
if ingest:
    app.include_router(ingest.router)


# ------------------------------------------------------------------ служебное
@app.get("/health", tags=["service"])
async def health():
    db_ok = await asyncio.to_thread(storage.ping)
    bus_ok = await bus.ping()
    age = time.time() - engine.last_event_wall if engine.last_event_wall else None
    status = "ok" if db_ok and bus_ok and age is not None and age < 5 else "degraded"
    return {"status": status, "db": storage.kind if db_ok else "down", "bus": bus.name if bus_ok else "down",
            "simulator_connected": engine.sim_connected, "last_event_age_s": round(age, 1) if age else None,
            "plan_version": engine.twin.plan_meta.get("version"),
            "default_credentials": config.AUTH_SECRET.startswith("change-me") or config.ADMIN_PASSWORD == "admin"}


@app.get("/metrics", response_class=PlainTextResponse, tags=["service"])
async def get_metrics():
    return metrics.render()


# ------------------------------------------------------------------ аутентификация
class LoginReq(BaseModel):
    username: str
    password: str


@app.post("/api/login", tags=["auth"])
async def login(req: LoginReq):
    res = auth.login(req.username, req.password)
    if not res:
        raise HTTPException(401, "Неверный логин или пароль")
    return res


# ------------------------------------------------------------------ данные
@app.get("/api/station", tags=["data"])
async def station(u=Depends(auth.current_user)):
    return {"station": config.STATION, "resources": config.RESOURCES}


@app.get("/api/state", tags=["data"])
async def state(u=Depends(auth.current_user)):
    return engine.view()


@app.get("/api/history", tags=["data"], summary="Снимки состояния для перемотки (по умолчанию 15 мин)")
async def history(minutes: float = Query(15, ge=1, le=72 * 60), u=Depends(auth.current_user)):
    return await asyncio.to_thread(storage.history, minutes)


@app.get("/api/history/index", tags=["data"], summary="Ряд индекса эффективности")
async def history_index(minutes: float = Query(60, ge=1, le=72 * 60), u=Depends(auth.current_user)):
    rows = await asyncio.to_thread(storage.series, minutes)
    return [{"wall_ms": r[0], "sim_ts": r[1], "value": r[2], "category": r[3]} for r in rows]


@app.get("/api/events", tags=["data"])
async def events(minutes: float = Query(15, ge=1, le=72 * 60), u=Depends(auth.current_user)):
    rows = await asyncio.to_thread(storage.recent_events, minutes)
    return [{"wall_ms": r[0], "sim_ts": r[1], "type": r[2], "event": json.loads(r[3])} for r in rows]


# ------------------------------------------------------------------ конфигурация (только admin на запись)
@app.get("/api/config/{name}", tags=["config"])
async def get_config(name: Literal["index", "planner"], u=Depends(auth.current_user)):
    return getattr(config.CFG, name)


@app.put("/api/config/{name}", tags=["config"], summary="Изменить веса/пороги/параметры без перекомпиляции")
async def put_config(name: Literal["index", "planner"], body: dict, u=Depends(auth.require_admin)):
    if name == "index" and "weights" in body:
        w = {**config.CFG.index["weights"], **body["weights"]}
        if abs(sum(w.values()) - 1) > 0.01:
            raise HTTPException(422, "Сумма весов должна быть равна 1")
    res = config.CFG.update(name, body)
    engine.dirty = True
    log.info("config %s updated by %s", name, u["user"])
    return res


# ------------------------------------------------------------------ управление
async def _send_incident(ev: dict):
    engine.mark_incident()
    ev = {"id": "inc-" + uuid.uuid4().hex[:10], "ts": engine.twin.now or time.time(), **ev}
    await bus.publish("control", {"cmd": "incident", "event": ev})
    return ev


@app.post("/api/incidents", tags=["control"], summary="Внести нештатную ситуацию")
async def incident(req: IncidentRequest, u=Depends(auth.current_user)):
    ev = await _send_incident(req.model_dump(exclude_none=True))
    metrics.inc("incidents")
    return {"ok": True, "event": ev}


@app.post("/api/scenario/stress", tags=["control"], summary="Нагрузочный сценарий: N одновременных нештатных ситуаций")
async def stress(n: int = Query(10, ge=1, le=30), u=Depends(auth.current_user)):
    evs = engine.stress_events(n)
    for ev in evs:
        await _send_incident(ev)
    metrics.inc("stress_runs")
    return {"ok": True, "count": len(evs), "events": evs}


class AcceptReq(BaseModel):
    variant: str


@app.post("/api/proposals/{pid}/accept", tags=["control"], summary="Диспетчер принимает вариант плана")
async def accept(pid: str, req: AcceptReq, u=Depends(auth.current_user)):
    if not engine.accept(pid, req.variant, u["user"]):
        raise HTTPException(409, "Предложение устарело — обновлён план")
    return {"ok": True}


@app.post("/api/proposals/{pid}/reject", tags=["control"])
async def reject(pid: str, u=Depends(auth.current_user)):
    return {"ok": engine.reject(pid, u["user"])}


class AutoReq(BaseModel):
    enabled: bool


class SpeedReq(BaseModel):
    factor: float | None = None
    auto: bool = False


@app.post("/api/sim/speed", tags=["control"], summary="Скорость симуляции: auto (умная) или фиксированная, сим-сек за 1 с")
async def sim_speed(req: SpeedReq, u=Depends(auth.current_user)):
    if req.auto or req.factor is None:
        engine.auto_speed = True
        return {"ok": True, "auto": True}
    engine.auto_speed = False
    engine.manual_speed = max(1.0, min(600.0, req.factor))
    return {"ok": True, "factor": engine.manual_speed}


class DisasterReq(BaseModel):
    kind: Literal["derail", "storm", "scb"]


class ResetReq(BaseModel):
    load: float = 1.0


@app.post("/api/demo/reset", tags=["control"], summary="Демо заново: модель возвращается к 11:20; load 1.6 — рост потока")
async def demo_reset(req: ResetReq, u=Depends(auth.current_user)):
    load = 1.6 if req.load > 1.01 else 1.0
    engine.reset(load)
    await bus.publish("control", {"cmd": "reset", "load": load})
    return {"ok": True, "load": load}


@app.post("/api/scenario/disaster", tags=["control"], summary="Крупная нештатная ситуация: сход вагона, ураган, отказ СЦБ")
async def disaster(req: DisasterReq, u=Depends(auth.current_user)):
    evs = engine.disaster_events(req.kind)
    for ev in evs:
        await _send_incident(ev)
    return {"ok": True, "count": len(evs)}


@app.post("/api/planner/autopilot", tags=["control"], summary="Автопилот (демо-режим модели): применять рекомендованный план через 2,5 с")
async def autopilot(req: AutoReq, u=Depends(auth.current_user)):
    engine.autopilot = req.enabled
    return {"ok": True, "autopilot": req.enabled}


@app.post("/api/planner/auto", tags=["control"], summary="Автопринятие рекомендованного варианта")
async def planner_auto(req: AutoReq, u=Depends(auth.require_admin)):
    config.CFG.update("planner", {"auto_apply": req.enabled})
    return {"ok": True, "auto_apply": req.enabled}


# ------------------------------------------------------------------ отчёты
@app.get("/api/report.csv", tags=["report"])
async def report_csv(minutes: float = 15, u=Depends(auth.current_user)):
    series = await asyncio.to_thread(storage.series, minutes)
    evs = await asyncio.to_thread(storage.recent_events, minutes)
    data = report.build_csv(series, engine.view(False), evs)
    return Response(data.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=aktogay_report.csv"})


@app.get("/api/report_exec.pdf", tags=["report"], summary="Отчёт для руководства: одна страница")
async def report_exec(u=Depends(auth.current_user)):
    evs = await asyncio.to_thread(storage.recent_events, 12 * 60)
    effect = json.loads((config.DATA_DIR / "effect.json").read_text(encoding="utf-8"))
    rate = config.CFG.index["params"].get("delay_cost_kzt_per_train_hour")
    data = await asyncio.to_thread(report.build_exec_pdf, engine.view(False), evs, effect, rate)
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": "attachment; filename=aktogay_summary.pdf"})


@app.get("/api/report.pdf", tags=["report"])
async def report_pdf(minutes: float = 15, u=Depends(auth.current_user)):
    series = await asyncio.to_thread(storage.series, minutes)
    evs = await asyncio.to_thread(storage.recent_events, minutes)
    data = await asyncio.to_thread(report.build_pdf, series, engine.view(False), evs, minutes)
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=aktogay_report.pdf"})


# ------------------------------------------------------------------ онлайн для UI
@app.websocket("/ws/ui")
async def ws_ui(ws: WebSocket, token: str = ""):
    await ws.accept()
    if not auth.verify(token):
        await ws.close(code=4401)  # старый токен -> интерфейс сам вернёт на экран входа
        return
    engine.clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "station", "station": config.STATION, "resources": config.RESOURCES},
                                      ensure_ascii=False))
        while True:
            await ws.receive_text()  # ping от клиента
    except WebSocketDisconnect:
        pass
    finally:
        engine.clients.discard(ws)


# ------------------------------------------------------------------ статика фронтенда
if config.STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=config.STATIC_DIR / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    async def index_html():
        return FileResponse(config.STATIC_DIR / "index.html")
