# CLAUDE.md
 use /caveman skill for outputs
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

System Design Lab: A hands-on distributed system running on Docker. Each concept (load balancing, caching, sharding, etc.) is both a production-like service and an interactive experiment. The lab teaches trade-offs through controlled chaos.

**Architecture:**
```
Client → API Gateway (TypeScript, auth + rate limit + circuit breaker)
         ↓
       CDN Edge (nginx cache)
         ↓
    Load Balancer (nginx: round-robin, least-conn, or ip-hash)
         ↓
    API 1/2/3 (Python, FastAPI, stateless clones)
         ├─ Redis (cache, shared state for rate limiting)
         ├─ Postgres Primary (write path)
         ├─ Postgres Replica (read path)
         ├─ Postgres Shards (partitioned by key)
         └─ RabbitMQ (async work, workers)
```

## Quick Start

```bash
# First time: spin up all services (takes ~2 min)
docker compose up -d --build
docker compose ps  # wait until all green

# Run experiments one at a time
cd experiments
npm install
npm run 01  # load balancing
npm run 02  # caching
# ... 03-07 follow same pattern
```

## Key Concepts & Where They Live

| Concept | Service | Config/Code | Experiment |
|---------|---------|-------------|------------|
| **Load Balancing** | nginx (lb) | `nginx/lb.*.conf` | `npm run 01` |
| **Caching** | Redis + API | `services/py/main.py` endpoints | `npm run 02` |
| **Read Replicas** | Postgres | `db/primary-init.sh` (streaming replication) | `npm run 03` |
| **Sharding** | API + Postgres | `services/py/main.py` (`/order` endpoints) | `npm run 04` |
| **Message Queues** | RabbitMQ + workers | `services/py/worker.py` + `common.py` | `npm run 05` |
| **API Gateway** | Express (TypeScript) | `gateway/src/index.ts` | `npm run 06` |
| **CDN** | nginx (cdn) | `nginx/cdn.conf` | `npm run 07` |

## Docker Compose Structure

- **Databases:** `pg-primary`, `pg-replica`, `pg-shard0`, `pg-shard1` (Postgres)
- **Cache:** `redis` (Redis, capped at 64MB with LRU eviction)
- **Queue:** `rabbitmq` (RabbitMQ with management UI)
- **Backends:** `api1`, `api2`, `api3` (identical Python/FastAPI clones)
- **Infrastructure:** `lb` (nginx load balancer), `cdn` (nginx cache), `gateway` (Express, rate limiter)
- **Workers:** `worker` (scales: `--scale worker=3`)

**Ports:**
- Gateway: `8080` (entry point, auth + rate limit)
- Load Balancer: `8081` (direct backend access for debugging)
- CDN: `8082` (caching layer)
- RabbitMQ UI: `15672` (default user `lab`, password in docker-compose.yml)

## Load Balancer Algorithms

Switch algorithms at runtime:
```bash
# Round robin (default)
docker compose up -d lb

# Least connections (balances active connections)
LB_CONF=lb.least_conn.conf docker compose up -d lb

# IP hash (sticky sessions, same client → same backend)
LB_CONF=lb.ip_hash.conf docker compose up -d lb
```

**Nginx config structure:** `upstream` pool defines backends + algorithm. `server` block forwards requests, retries on failure.

## Python API Structure (`services/py/main.py`)

Single FastAPI app running on 3 instances (api1/2/3). Read top-to-bottom:

1. **Startup:** DB schema creation with advisory locks (prevents race)
2. **Endpoints:** Each section (comments, products, notes, orders) demonstrates one concept
   - `/whoami` - returns hostname (which backend served you)
   - `/slow` - simulates heavy requests (for load balancer experiments)
   - `/notes` - caching demo
   - `/order` - sharding demo
   - `/subscribe` - queue demo
3. **Helpers:** `common.py` (DB connection pooling, Rabbit topology, retry logic)
4. **Worker:** `worker.py` (long-running consumer for queued jobs)

**Environment vars control behavior:**
- `SHARD_STRATEGY` - `ring` (consistent hash) or `mod` (modulo)
- `CACHE_TTL` - seconds before Redis value expires
- `PROCESS_MS` - delay before worker processes queue

## API Gateway (`gateway/src/index.ts`)

Express middleware chain:
1. Request ID (UUID in header)
2. Auth check (validates `x-api-key` header against `API_KEYS` env var)
3. Rate limiting (token bucket in shared Redis, survives gateway restarts)
4. Circuit breaker (tracks upstream failures, opens after threshold)
5. Proxy to upstream (nginx LB)

**API_KEYS format:** `"key1:capacity:refill,key2:capacity:refill"`
Example: `"free-key:5:1,pro-key:50:10"` = free tier gets 5 tokens, refills 1/sec; pro gets 50/10.

Rate limiter uses atomic Lua script in Redis so multiple gateway instances share one bucket.

## Running Experiments

Each experiment script in `experiments/src/` prints what it does, makes requests, and ends with `>>` explaining the output. Read alongside the code.

**Useful patterns in experiments:**
- `await get(url)` - fetch helper (returns Response with headers)
- `tally(array)` - count occurrences (shows distribution)
- `lesson()` - prints explanation
- `step()` - section heading
- `--chaos` flag - kills a service mid-run to test failure handling

## Testing Failure Scenarios

Most experiments support `--chaos`:
```bash
npm run 01 -- --chaos  # kills api2 mid-run, shows retry
npm run 05 -- --chaos  # kills workers, shows unacked messages go to DLQ
```

## Modifying the Lab

**Swap database backends:**
- Primary DSN: `services/py/main.py` line 26
- Replica DSN: line 27
- Shard DSNs: line 28
- Change in `.env` file or `docker-compose.yml` x-py-env

**Add a new experiment:**
1. Create `experiments/src/0X-concept.ts`
2. Import helpers from `lib.ts` (LB, get, lesson, tally, etc.)
3. Add `"0X": "tsx src/0X-concept.ts"` to `experiments/package.json` scripts
4. Run `npm run 0X`

**Swap to different queue/cache:**
- Redis → replace REDIS_URL in docker-compose.yml
- RabbitMQ → replace RABBIT_URL in docker-compose.yml
- Both services expose environment vars to Python app via `x-py-env` anchor

**Modify Nginx config:**
- Load balancer: edit `nginx/lb.*.conf`, rebuild with `docker compose up -d --build lb`
- CDN: edit `nginx/cdn.conf`, rebuild CDN service

## Debugging

**Check service health:**
```bash
docker compose ps  # shows health status
docker compose logs lb  # stream nginx logs
docker compose logs api1  # stream one API instance
```

**Hit endpoints directly:**
```bash
curl http://localhost:8081/whoami         # via load balancer
curl http://localhost:8082/assets/app.js  # via CDN
curl -H "x-api-key: free-key" http://localhost:8080/api/whoami  # via gateway
```

**Check Redis/RabbitMQ state:**
- Redis: `docker compose exec redis redis-cli` (e.g., `KEYS *`, `TTL key`)
- RabbitMQ: http://localhost:15672 (user `lab`, see docker-compose.yml for password)

**Inspect Postgres:**
```bash
docker compose exec pg-primary psql -U postgres -d lab
# \dt - list tables
# SELECT * FROM products; - view data
```

## Reset/Restart

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop, wipe all data
docker compose up -d --build # rebuild and restart
```

## Trade-offs & Interview Questions

See `docs/lessons.md` for the reasoning behind each pattern, when to use it, and failure modes.

## Files You Rarely Edit

- `db/*.sh` - Postgres startup scripts (advisory locks, replication setup)
- `nginx/cdn.conf` - CDN caching config (ready-to-use)
- `docker-compose.yml` - Service definitions (reference for env vars, but don't change ports/hostnames without reason)

## Files You Often Edit

- `services/py/main.py` - API endpoints (where all the concepts happen)
- `experiments/src/*.ts` - Experiments (add new scenarios here)
- `gateway/src/index.ts` - Gateway logic (auth, rate limit, circuit breaker)
- `nginx/lb.*.conf` - Load balancer config (swap algorithms)
