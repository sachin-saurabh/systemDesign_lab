# System Design Lab

A hands-on lab for learning system design. You run a small but real distributed system on your own machine and break it on purpose. Everything runs in Docker, so it costs nothing.

```
                         ┌────────────┐
 client ──► API gateway ─┤ auth       │
            (TypeScript) │ rate limit │
                         │ breaker    │
                         └─────┬──────┘
                               ▼
 client ──► CDN edge ───► Load balancer (nginx) ──► api1 / api2 / api3 (Python, FastAPI)
            (nginx cache)                               │      │       │
                                       ┌────────────────┼──────┼───────┼───────────┐
                                       ▼                ▼      ▼       ▼           ▼
                                  Redis cache     Postgres   Postgres  Shard 0/1  RabbitMQ ──► workers
                                                   primary ─► replica  (sharded)   (queue)     (scale them)
```

| Concept | Where it lives | Experiment |
|---|---|---|
| Load balancing | `nginx/lb.*.conf` | `npm run 01` |
| Caching | `services/py/main.py` (Redis) | `npm run 02` |
| Read replicas | `db/*.sh`, Postgres streaming replication | `npm run 03` |
| Sharding and consistent hashing | `services/py/main.py` | `npm run 04` |
| Message queues, DLQ, fan-out | `services/py/worker.py`, RabbitMQ | `npm run 05` |
| API gateway, rate limiting, circuit breaker | `gateway/src/index.ts` | `npm run 06` |
| CDN | `nginx/cdn.conf` | `npm run 07` |

## Requirements

- Docker with Docker Compose v2 (about 3 GB of free RAM)
- Node 20+ (for the TypeScript experiments)

## Run it

```bash
docker compose up -d --build        # first start takes a few minutes
docker compose ps                   # wait until everything is healthy

cd experiments
npm install
npm run 01                          # then 02, 03, ... 07
```

Each experiment prints what it is doing and ends with a `>>` line explaining what you just saw. Read the code of the experiment next to its output.

Useful URLs (all bound to localhost only):

- Gateway: http://localhost:8080/api/whoami (header `x-api-key: free-key` or `pro-key`)
- Load balancer, direct: http://localhost:8081/docs (interactive API docs for every endpoint)
- CDN: http://localhost:8082/assets/app.js
- RabbitMQ UI: http://localhost:15672 (user `lab`, password from `docker-compose.yml` or your `.env`)

## Suggested path

Do one concept per sitting, in this order. Each builds on the last.

1. **Load balancing** (01). Then switch algorithms: `LB_CONF=lb.least_conn.conf docker compose up -d lb` and re-run.
2. **Caching** (02). Pay attention to the stampede and the stale-cache trap.
3. **Read replicas** (03). This is where consistency trade-offs first show up.
4. **Sharding** (04). Restart with `SHARD_STRATEGY=mod docker compose up -d api1 api2 api3` and compare.
5. **Message queues** (05). Re-run with `docker compose up -d --scale worker=3`.
6. **API gateway** (06).
7. **CDN** (07).

Then read [docs/lessons.md](docs/lessons.md) for the trade-offs and interview-style questions behind each one.

## Reset or stop

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop and wipe all data
```

## Credentials

The default passwords in `docker-compose.yml` are for throwaway local containers. Ports bind to `127.0.0.1` only. To change them, copy `.env.example` to `.env`. Never reuse these values on anything real.

## Taking it to the cloud, still free

The lab mirrors real services you can use on free tiers. Free tiers change often, so check each provider's current limits before relying on them.

| Lab component | Free-tier-friendly equivalent |
|---|---|
| CDN | Cloudflare (free plan) in front of any site |
| Redis cache | Upstash Redis, Redis Cloud free tier |
| Postgres | Neon, Supabase free tiers |
| RabbitMQ | CloudAMQP free plan |
| App servers + LB | Fly.io, Render, Railway, or an always-free VM; Cloudflare Workers also work as a gateway |

A good first cloud exercise: deploy the Python API to one free host, put Cloudflare in front for CDN and caching, and point it at free managed Postgres and Redis.

## Exercises once you finish

- Add a third shard and write a script that migrates only the keys that move under consistent hashing.
- Implement write-behind caching (write to Redis, flush to Postgres asynchronously) and find its failure mode.
- Make the order consumer idempotent so a redelivered message cannot double-charge.
- Add retries with backoff before a message is dead-lettered.
- Add a second gateway instance and prove the shared Redis bucket still enforces one limit.
- Add active health checks to the load balancer.
