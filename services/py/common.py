"""Shared by the API and the worker: connection settings and the RabbitMQ topology."""
import asyncio
import os
import socket

import aio_pika

HOSTNAME = socket.gethostname()
RABBIT_URL = os.environ.get("RABBIT_URL", "amqp://guest:guest@rabbitmq/")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")

ORDERS_Q = "orders"            # work queue: each message is handled by exactly one worker
DLX = "dlx"                    # dead-letter exchange: where rejected messages end up
DLQ = "orders.dlq"             # dead-letter queue: parking lot for poison messages
EVENTS_X = "events"            # fanout exchange: every bound queue gets a copy (pub/sub)
EVENT_QUEUES = ("events.email", "events.analytics")


async def retry(fn, what: str, attempts: int = 30, delay: float = 2.0):
    """Keep trying until a dependency is up. Containers start in arbitrary order."""
    for _ in range(attempts):
        try:
            return await fn()
        except Exception as exc:  # noqa: BLE001 - we want to retry on anything
            print(f"[{HOSTNAME}] waiting for {what}: {exc}", flush=True)
            await asyncio.sleep(delay)
    raise RuntimeError(f"could not connect to {what}")


async def declare_topology(channel):
    """Idempotent: safe for every process to call at startup. Returns the events exchange."""
    dlx = await channel.declare_exchange(DLX, aio_pika.ExchangeType.DIRECT, durable=True)
    dlq = await channel.declare_queue(DLQ, durable=True)
    await dlq.bind(dlx, routing_key=DLQ)

    await channel.declare_queue(
        ORDERS_Q,
        durable=True,
        arguments={"x-dead-letter-exchange": DLX, "x-dead-letter-routing-key": DLQ},
    )

    events = await channel.declare_exchange(EVENTS_X, aio_pika.ExchangeType.FANOUT, durable=True)
    for name in EVENT_QUEUES:
        queue = await channel.declare_queue(name, durable=True)
        await queue.bind(events)
    return events
