"""Шина событий: встроенная (asyncio) или Redis Streams. Интерфейс одинаковый."""
import asyncio
import json
import logging

log = logging.getLogger("bus")


class MemoryBus:
    name = "memory"

    def __init__(self):
        self.subs: dict[str, list[asyncio.Queue]] = {}

    async def start(self):
        pass

    async def publish(self, topic: str, msg: dict):
        for q in self.subs.get(topic, []):
            if q.full():
                q.get_nowait()  # backpressure: старое сообщение вытесняется
            q.put_nowait(msg)

    async def subscribe(self, topic: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=20000)
        self.subs.setdefault(topic, []).append(q)
        return q

    async def ping(self) -> bool:
        return True


class RedisBus:
    name = "redis"

    def __init__(self, url: str):
        import redis.asyncio as aioredis
        self.r = aioredis.from_url(url, decode_responses=True)
        self.tasks = []

    async def start(self):
        await self.r.ping()

    async def publish(self, topic: str, msg: dict):
        await self.r.xadd(f"ds:{topic}", {"d": json.dumps(msg, ensure_ascii=False)}, maxlen=20000, approximate=True)

    async def subscribe(self, topic: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=20000)

        async def reader():
            last = "$"
            backoff = 0.5
            while True:
                try:
                    res = await self.r.xread({f"ds:{topic}": last}, block=1000, count=500)
                    backoff = 0.5
                    for _, entries in res or []:
                        for eid, fields in entries:
                            last = eid
                            if q.full():
                                q.get_nowait()
                            q.put_nowait(json.loads(fields["d"]))
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # reconnect с backoff
                    log.warning("redis read error %s, retry in %.1fs", e, backoff)
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 10)

        self.tasks.append(asyncio.create_task(reader()))
        return q

    async def ping(self) -> bool:
        try:
            return bool(await self.r.ping())
        except Exception:
            return False


def make_bus(kind: str, url: str):
    return RedisBus(url) if kind == "redis" else MemoryBus()
