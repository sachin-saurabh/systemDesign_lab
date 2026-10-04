"""System Design Lab API.

One small service that exposes every concept in this lab as an endpoint, so you can
poke it with curl, a browser, or the experiment scripts. Read top to bottom: each
section is one concept.
"""
import asyncio
import bisect
import functools
import hashlib
import json
import os
import time
import uuid
from contextlib import asynccontextmanager

import aio_pika
import asyncpg
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from common import (DLQ, EVENTS_X, HOSTNAME, ORDERS_Q, RABBIT_URL, REDIS_URL,
                    declare_topology, retry)

PRIMARY_DSN = os.environ["PRIMARY_DSN"]
REPLICA_DSN = os.environ["REPLICA_DSN"]
SHARD_DSNS = [d for d in os.environ["SHARD_DSNS"].split(",") if d]
CACHE_TTL = int(os.getenv("CACHE_TTL", "30"))
SHARD_STRATEGY = os.getenv("SHARD_STRATEGY", "ring")  # "ring" or "mod"
PROCESS_MS = int(os.getenv("PROCESS_MS", "300"))


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------
async def setup_schema(app: FastAPI) -> None:
    # Three API instances start at once; an advisory lock stops them racing on DDL.
    async with app.state.primary.acquire() as c:
        await c.execute("SELECT pg_advisory_lock(4242)")
        try:
            await c.execute(
                """
                CREATE TABLE IF NOT EXISTS products (
                    id int PRIMARY KEY, name text NOT NULL,
                    price_cents int NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
                CREATE TABLE IF NOT EXISTS notes (
                    id serial PRIMARY KEY, body text NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now());
                """
            )
            await c.execute(
                "INSERT INTO products(id, name, price_cents) "
                "SELECT g, 'Product ' || g, 1000 + g * 10 FROM generate_series(1, 20) g "
                "ON CONFLICT DO NOTHING"
            )
        finally:
            await c.execute("SELECT pg_advisory_unlock(4242)")
    for pool in app.state.shards:
        async with pool.acquire() as c:
            await c.execute("SELECT pg_advisory_lock(4243)")
            try:
                await c.execute(
                    "CREATE TABLE IF NOT EXISTS users (id bigint PRIMARY KEY, name text NOT NULL)"
                )
            finally:
                await c.execute("SELECT pg_advisory_unlock(4243)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.primary = await retry(lambda: asyncpg.create_pool(PRIMARY_DSN, min_size=1, max_size=5), "primary db")
    app.state.replica = await retry(lambda: asyncpg.create_pool(REPLICA_DSN, min_size=1, max_size=5), "replica db")
    app.state.shards = [
        await retry(lambda d=d: asyncpg.create_pool(d, min_size=1, max_size=5), "shard db")
        for d in SHARD_DSNS
    ]
    app.state.redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    await setup_schema(app)

    app.state.mq = await retry(lambda: aio_pika.connect_robust(RABBIT_URL), "rabbitmq")
    app.state.mq_channel = await app.state.mq.channel()
    app.state.events_x = await declare_topology(app.state.mq_channel)
    yield
    await app.state.mq.close()
    await app.state.redis.aclose()
    for pool in [app.state.primary, app.state.replica, *app.state.shards]:
        await pool.close()


app = FastAPI(title="System Design Lab", lifespan=lifespan)


@app.middleware("http")
async def add_served_by(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Served-By"] = HOSTNAME  # which instance answered (load balancing demo)
    return response


# ---------------------------------------------------------------------------
# 1. Load balancing: these endpoints exist so you can see which backend answered
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/whoami")
async def whoami():
    return {"served_by": HOSTNAME}


@app.get("/slow")
async def slow(ms: int = 500):
    """A request that holds its connection open. Used to compare balancing algorithms."""
    await asyncio.sleep(min(max(ms, 0), 10_000) / 1000)
    return {"served_by": HOSTNAME, "slept_ms": ms}


@app.get("/boom")
async def boom():
    """Always fails. Used to trip the gateway's circuit breaker."""
    raise HTTPException(500, "boom")


# ---------------------------------------------------------------------------
# 2. Caching: cache-aside, stampede protection, invalidation vs write-through
# ---------------------------------------------------------------------------
class PriceIn(BaseModel):
    price_cents: int = Field(ge=0)


async def load_product(pid: int) -> dict:
    """The 'expensive' read. Reads from the replica and takes ~200ms."""
    await app.state.redis.incr("stats:db_hits")
    async with app.state.replica.acquire() as c:
        await c.execute("SELECT pg_sleep(0.2)")  # pretend this is a heavy query
        row = await c.fetchrow(
            "SELECT id, name, price_cents, updated_at::text AS updated_at FROM products WHERE id = $1",
            pid,
        )
    if row is None:
        raise HTTPException(404, "no such product")
    return dict(row)


async def load_with_lock(pid: int) -> tuple[dict, str]:
    """Only one caller rebuilds the cache entry; the others wait for it (anti-stampede)."""
    r = app.state.redis
    key = f"product:{pid}"
    lock = f"lock:{key}"
    token = uuid.uuid4().hex
    if await r.set(lock, token, nx=True, px=5000):
        try:
            product = await load_product(pid)
            await r.set(key, json.dumps(product), ex=CACHE_TTL)
            return product, "db"
        finally:
            # Not atomic (a Lua script would be); fine for a lab.
            if await r.get(lock) == token:
                await r.delete(lock)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        await asyncio.sleep(0.05)
        cached = await r.get(key)
        if cached:
            return json.loads(cached), "cache(waited)"
    product = await load_product(pid)
    await r.set(key, json.dumps(product), ex=CACHE_TTL)
    return product, "db"


@app.get("/products/{pid}")
async def get_product(pid: int, response: Response, strategy: str = "cache-aside"):
    """strategy = none | cache-aside | lock"""
    started = time.perf_counter()
    r = app.state.redis
    key = f"product:{pid}"
    if strategy == "none":
        product, source, header = await load_product(pid), "db", "BYPASS"
    else:
        cached = await r.get(key)
        if cached:
            product, source, header = json.loads(cached), "cache", "HIT"
        elif strategy == "lock":
            product, source = await load_with_lock(pid)
            header = "HIT" if source.startswith("cache") else "MISS"
        else:
            product = await load_product(pid)
            await r.set(key, json.dumps(product), ex=CACHE_TTL)
            source, header = "db", "MISS"
    response.headers["X-Cache"] = header
    return {
        "product": product,
        "source": source,
        "ms": round((time.perf_counter() - started) * 1000, 1),
        "served_by": HOSTNAME,
    }


@app.put("/products/{pid}")
async def update_product(pid: int, body: PriceIn, mode: str = "invalidate"):
    """mode = invalidate (delete the cache key) | write-through (overwrite it)"""
    async with app.state.primary.acquire() as c:
        row = await c.fetchrow(
            "UPDATE products SET price_cents = $2, updated_at = now() WHERE id = $1 "
            "RETURNING id, name, price_cents, updated_at::text AS updated_at",
            pid, body.price_cents,
        )
    if row is None:
        raise HTTPException(404, "no such product")
    product = dict(row)
    key = f"product:{pid}"
    if mode == "write-through":
        await app.state.redis.set(key, json.dumps(product), ex=CACHE_TTL)
    else:
        await app.state.redis.delete(key)
    return {"product": product, "mode": mode}


@app.delete("/cache")
async def flush_cache():
    r = app.state.redis
    keys = [k async for k in r.scan_iter("product:*")] + [k async for k in r.scan_iter("lock:*")]
    if keys:
        await r.delete(*keys)
    return {"deleted": len(keys)}


@app.get("/stats")
async def stats():
    r = app.state.redis
    return {"db_hits": int(await r.get("stats:db_hits") or 0)}


@app.post("/stats/reset")
async def stats_reset():
    await app.state.redis.delete(
        "stats:db_hits", "stats:processed", "stats:failed", "stats:consumers", "stats:events"
    )
    return {"reset": True}


# ---------------------------------------------------------------------------
# 3. Read replicas: write to the primary, read from the replica, watch it lag
# ---------------------------------------------------------------------------
class NoteIn(BaseModel):
    body: str


@app.post("/notes", status_code=201)
async def create_note(note: NoteIn):
    async with app.state.primary.acquire() as c:
        note_id = await c.fetchval("INSERT INTO notes(body) VALUES($1) RETURNING id", note.body)
    return {"id": note_id, "written_to": "primary"}


@app.get("/notes/{nid}")
async def get_note(nid: int, source: str = "replica"):
    pool = app.state.primary if source == "primary" else app.state.replica
    async with pool.acquire() as c:
        row = await c.fetchrow(
            "SELECT id, body, created_at::text AS created_at FROM notes WHERE id = $1", nid
        )
    if row is None:
        raise HTTPException(404, f"note {nid} not found on {source} (not replicated yet?)")
    return {**dict(row), "read_from": source}


@app.get("/replica/status")
async def replica_status():
    row = await app.state.replica.fetchrow(
        """
        SELECT pg_is_in_recovery() AS is_replica,
               pg_get_wal_replay_pause_state() AS replay_state,
               COALESCE(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)::bigint
                   AS unapplied_wal_bytes
        """
    )
    return dict(row)


@app.post("/admin/replica/{action}")
async def replica_replay(action: str):
    """Pause or resume WAL replay on the replica to create replication lag on demand."""
    if action not in ("pause", "resume"):
        raise HTTPException(400, "action must be pause or resume")
    fn = "pg_wal_replay_pause" if action == "pause" else "pg_wal_replay_resume"
    await app.state.replica.execute(f"SELECT {fn}()")
    if action == "pause":
        for _ in range(50):
            state = await app.state.replica.fetchval("SELECT pg_get_wal_replay_pause_state()")
            if state == "paused":
                break
            await asyncio.sleep(0.1)
    return await replica_status()


# ---------------------------------------------------------------------------
# 4. Sharding: route each key to one of N databases
# ---------------------------------------------------------------------------
def hash_key(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


class Ring:
    """Consistent hash ring. Each shard owns many points (virtual nodes) on the ring;
    a key belongs to the first point clockwise from its hash. Adding a shard only
    steals keys from its neighbours instead of reshuffling everything."""

    def __init__(self, n_nodes: int, vnodes: int = 100):
        points = sorted(
            (hash_key(f"shard-{n}#{v}"), n) for n in range(n_nodes) for v in range(vnodes)
        )
        self._hashes = [p[0] for p in points]
        self._nodes = [p[1] for p in points]

    def node_for(self, key: str) -> int:
        i = bisect.bisect(self._hashes, hash_key(key)) % len(self._hashes)
        return self._nodes[i]


@functools.lru_cache(maxsize=64)
def get_ring(n: int) -> Ring:
    return Ring(n)


def route(key: str, n: int, strategy: str) -> int:
    if strategy == "mod":
        return hash_key(key) % n
    return get_ring(n).node_for(key)


class UserIn(BaseModel):
    id: int
    name: str


UPSERT_USER = (
    "INSERT INTO users(id, name) VALUES($1, $2) "
    "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name"
)


@app.post("/shards/users", status_code=201)
async def put_user(user: UserIn):
    shard = route(str(user.id), len(app.state.shards), SHARD_STRATEGY)
    await app.state.shards[shard].execute(UPSERT_USER, user.id, user.name)
    return {"id": user.id, "shard": shard, "strategy": SHARD_STRATEGY}


@app.get("/shards/users/top")
async def top_users(limit: int = 5):
    """Scatter-gather: with no shard key, we must ask EVERY shard and merge the answers."""
    limit = min(max(limit, 1), 100)
    parts = await asyncio.gather(
        *(p.fetch("SELECT id, name FROM users ORDER BY id DESC LIMIT $1", limit) for p in app.state.shards)
    )
    merged = sorted((dict(r) for rows in parts for r in rows), key=lambda r: r["id"], reverse=True)
    return {"queried_shards": len(app.state.shards), "rows": merged[:limit]}


@app.get("/shards/users/{uid}")
async def get_user(uid: int):
    shard = route(str(uid), len(app.state.shards), SHARD_STRATEGY)
    row = await app.state.shards[shard].fetchrow("SELECT id, name FROM users WHERE id = $1", uid)
    if row is None:
        raise HTTPException(404, f"user {uid} not on shard {shard}")
    return {**dict(row), "shard": shard}


@app.post("/shards/users/bulk")
async def bulk_users(start: int = 1, count: int = 1000):
    count = min(max(count, 1), 100_000)
    n = len(app.state.shards)
    groups: list[list[tuple[int, str]]] = [[] for _ in range(n)]
    for uid in range(start, start + count):
        groups[route(str(uid), n, SHARD_STRATEGY)].append((uid, f"user-{uid}"))
    await asyncio.gather(
        *(pool.executemany(UPSERT_USER, groups[i]) for i, pool in enumerate(app.state.shards))
    )
    return {"inserted": count, "per_shard": [len(g) for g in groups]}


@app.get("/shards/distribution")
async def shard_distribution():
    counts = await asyncio.gather(
        *(p.fetchval("SELECT count(*) FROM users") for p in app.state.shards)
    )
    total = sum(counts)
    return {
        "strategy": SHARD_STRATEGY,
        "total": total,
        "shards": [
            {"shard": i, "rows": c, "share": round(c / total, 3) if total else 0}
            for i, c in enumerate(counts)
        ],
    }


@app.post("/shards/reset")
async def shards_reset():
    await asyncio.gather(*(p.execute("TRUNCATE users") for p in app.state.shards))
    return {"reset": True}


@app.get("/shards/simulate")
async def simulate_resharding(keys: int = 10_000, from_n: int = 2, to_n: int = 3):
    """Pure math, no database: what fraction of keys must move when the shard count changes?"""
    keys = min(max(keys, 1), 100_000)
    if not (1 <= from_n <= 64 and 1 <= to_n <= 64):
        raise HTTPException(400, "shard counts must be between 1 and 64")
    hashes = [hash_key(str(k)) for k in range(keys)]
    moved_mod = sum(1 for h in hashes if h % from_n != h % to_n)
    before, after = get_ring(from_n), get_ring(to_n)
    moved_ring = sum(1 for k in range(keys) if before.node_for(str(k)) != after.node_for(str(k)))
    ideal = abs(to_n - from_n) / max(from_n, to_n)
    return {
        "keys": keys,
        "from_shards": from_n,
        "to_shards": to_n,
        "moved_with_mod": round(moved_mod / keys, 3),
        "moved_with_consistent_hash": round(moved_ring / keys, 3),
        "theoretical_minimum": round(ideal, 3),
    }


# ---------------------------------------------------------------------------
# 5. Message queues: decouple slow work from the request
# ---------------------------------------------------------------------------
class OrderIn(BaseModel):
    item: str = "widget"
    qty: int = 1
    fail: bool = False  # ask the worker to fail on purpose, to demo dead-lettering


@app.post("/orders", status_code=202)
async def create_order(order: OrderIn):
    """Async: put the work on a queue and return immediately (202 Accepted)."""
    order_id = uuid.uuid4().hex[:8]
    payload = json.dumps({"id": order_id, **order.model_dump()}).encode()
    channel = app.state.mq_channel
    await channel.default_exchange.publish(
        aio_pika.Message(payload, delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                         content_type="application/json"),
        routing_key=ORDERS_Q,
    )
    # Also broadcast an event; the fanout exchange copies it to email + analytics queues.
    await app.state.events_x.publish(
        aio_pika.Message(json.dumps({"type": "order.created", "id": order_id}).encode()),
        routing_key="",
    )
    return {"id": order_id, "status": "queued"}


@app.post("/orders/sync")
async def create_order_sync(order: OrderIn):
    """Sync: do the slow work inside the request. The caller waits for all of it."""
    await asyncio.sleep(PROCESS_MS / 1000)
    return {"status": "processed inline", "served_by": HOSTNAME}


async def queue_depth(name: str) -> int:
    queue = await app.state.mq_channel.declare_queue(name, passive=True)
    return queue.declaration_result.message_count


@app.get("/queue/stats")
async def queue_stats():
    r = app.state.redis
    return {
        "waiting_in_orders": await queue_depth(ORDERS_Q),
        "dead_lettered": await queue_depth(DLQ),
        "processed": int(await r.get("stats:processed") or 0),
        "failed": int(await r.get("stats:failed") or 0),
        "by_consumer": await r.hgetall("stats:consumers"),
        "events_delivered": await r.hgetall("stats:events"),
    }


@app.post("/queue/purge")
async def queue_purge():
    channel = app.state.mq_channel
    for name in (ORDERS_Q, DLQ):
        queue = await channel.declare_queue(name, passive=True)
        await queue.purge()
    return {"purged": [ORDERS_Q, DLQ]}


# ---------------------------------------------------------------------------
# 6. CDN origin: a slow, cacheable static asset
# ---------------------------------------------------------------------------
@app.get("/assets/{name}")
async def asset(name: str, v: str = "1"):
    """The origin is slow (300ms) but marks its answer cacheable for 60s. A CDN in front
    pays that cost once, then serves copies instantly."""
    await asyncio.sleep(0.3)
    body = (f"/* {name} v{v} */\n" + "console.log('hello from the origin');\n" * 200).encode()
    return Response(
        body,
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=60", "ETag": f'"{hashlib.md5(body).hexdigest()}"'},
    )
