"""Хранилище краткосрочной истории: PostgreSQL/TimescaleDB или SQLite (демо). Хранение 72 ч."""
import json
import logging
import time

from sqlalchemy import (BigInteger, Column, Float, MetaData, String, Table, Text, create_engine, delete, insert,
                        select, text)

log = logging.getLogger("storage")
meta = MetaData()

snapshots = Table("snapshots", meta,
                  Column("wall_ms", BigInteger, nullable=False, index=True),
                  Column("sim_ts", Float), Column("index_value", Float), Column("category", String(16)),
                  Column("payload", Text))
events = Table("events", meta,
               Column("wall_ms", BigInteger, nullable=False, index=True),
               Column("sim_ts", Float), Column("type", String(32)), Column("payload", Text))
plans = Table("plans", meta,
              Column("wall_ms", BigInteger, nullable=False, index=True),
              Column("sim_ts", Float), Column("method", String(16)), Column("solve_ms", Float),
              Column("accepted_by", String(32)), Column("payload", Text))


class Storage:
    def __init__(self, url: str, retention_h: int = 72):
        self.url = url
        self.retention_ms = retention_h * 3600 * 1000
        kw = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
        self.engine = create_engine(url, **kw)
        self.kind = "sqlite" if url.startswith("sqlite") else "postgres"

    def init(self):
        meta.create_all(self.engine)
        if self.kind == "postgres":
            try:
                with self.engine.begin() as c:
                    c.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
                    for t in ("snapshots", "events", "plans"):
                        c.execute(text(f"SELECT create_hypertable('{t}', 'wall_ms', chunk_time_interval => 3600000, "
                                       f"if_not_exists => TRUE, migrate_data => TRUE)"))
                self.kind = "timescaledb"
            except Exception as e:
                log.warning("TimescaleDB недоступен, обычный PostgreSQL: %s", e)

    def write_snapshot(self, sim_ts, value, category, payload: dict):
        with self.engine.begin() as c:
            c.execute(insert(snapshots).values(wall_ms=int(time.time() * 1000), sim_ts=sim_ts, index_value=value,
                                               category=category, payload=json.dumps(payload, ensure_ascii=False)))

    def write_events(self, rows: list[dict]):
        if not rows:
            return
        now = int(time.time() * 1000)
        with self.engine.begin() as c:
            c.execute(insert(events), [{"wall_ms": now, "sim_ts": r.get("ts"), "type": r.get("type"),
                                        "payload": json.dumps(r, ensure_ascii=False)} for r in rows])

    def write_plan(self, sim_ts, method, solve_ms, accepted_by, payload):
        with self.engine.begin() as c:
            c.execute(insert(plans).values(wall_ms=int(time.time() * 1000), sim_ts=sim_ts, method=method,
                                           solve_ms=solve_ms, accepted_by=accepted_by,
                                           payload=json.dumps(payload, ensure_ascii=False)))

    def history(self, minutes: float, max_points: int = 240):
        since = int(time.time() * 1000 - minutes * 60000)
        with self.engine.connect() as c:
            rows = c.execute(select(snapshots.c.wall_ms, snapshots.c.payload)
                             .where(snapshots.c.wall_ms >= since).order_by(snapshots.c.wall_ms)).all()
        step = max(1, len(rows) // max_points)
        return [{"wall_ms": r[0], "view": json.loads(r[1])} for r in rows[::step]]

    def series(self, minutes: float):
        since = int(time.time() * 1000 - minutes * 60000)
        with self.engine.connect() as c:
            return c.execute(select(snapshots.c.wall_ms, snapshots.c.sim_ts, snapshots.c.index_value,
                                    snapshots.c.category).where(snapshots.c.wall_ms >= since)
                             .order_by(snapshots.c.wall_ms)).all()

    def recent_events(self, minutes: float, types=None):
        since = int(time.time() * 1000 - minutes * 60000)
        q = select(events.c.wall_ms, events.c.sim_ts, events.c.type, events.c.payload).where(events.c.wall_ms >= since)
        if types:
            q = q.where(events.c.type.in_(types))
        with self.engine.connect() as c:
            return c.execute(q.order_by(events.c.wall_ms)).all()

    def purge(self):
        lim = int(time.time() * 1000 - self.retention_ms)
        with self.engine.begin() as c:
            for t in (snapshots, events, plans):
                c.execute(delete(t).where(t.c.wall_ms < lim))

    def ping(self) -> bool:
        try:
            with self.engine.connect() as c:
                c.execute(text("SELECT 1"))
            return True
        except Exception:
            return False
