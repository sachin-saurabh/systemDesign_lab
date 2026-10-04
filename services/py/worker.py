"""Queue consumer. Run several copies to see competing consumers share the work:
    docker compose up -d --scale worker=3
"""
import asyncio
import json
import os

import aio_pika
import redis.asyncio as aioredis

from common import (EVENT_QUEUES, HOSTNAME, ORDERS_Q, RABBIT_URL, REDIS_URL,
                    declare_topology, retry)

PROCESS_MS = int(os.getenv("PROCESS_MS", "300"))


async def main() -> None:
    r = aioredis.from_url(REDIS_URL, decode_responses=True)
    conn = await retry(lambda: aio_pika.connect_robust(RABBIT_URL), "rabbitmq")
    channel = await conn.channel()
    # Prefetch 1: don't hand a worker a second message until it finishes the first.
    # Without this, one worker could hoard messages while others sit idle.
    await channel.set_qos(prefetch_count=1)
    await declare_topology(channel)

    async def on_order(message: aio_pika.IncomingMessage) -> None:
        try:
            # process() acks on success. On an exception it rejects WITHOUT requeue,
            # so the broker dead-letters the message to orders.dlq.
            async with message.process(requeue=False):
                order = json.loads(message.body)
                await asyncio.sleep(PROCESS_MS / 1000)  # pretend to do real work
                if order.get("fail"):
                    raise ValueError(f"order {order['id']} cannot be processed")
                await r.incr("stats:processed")
                await r.hincrby("stats:consumers", HOSTNAME, 1)
        except ValueError as exc:
            await r.incr("stats:failed")
            print(f"[{HOSTNAME}] rejected -> DLQ: {exc}", flush=True)

    def make_event_handler(kind: str):
        async def handler(message: aio_pika.IncomingMessage) -> None:
            async with message.process():
                await r.hincrby("stats:events", kind, 1)
        return handler

    orders = await channel.get_queue(ORDERS_Q)
    await orders.consume(on_order)
    for name in EVENT_QUEUES:
        queue = await channel.get_queue(name)
        await queue.consume(make_event_handler(name.split(".", 1)[1]))

    print(f"[{HOSTNAME}] worker ready", flush=True)
    await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
