# Lessons: the trade-offs behind each concept

Each section: what it is, why it exists, what it costs, and questions to test yourself. The experiments let you see each trade-off happen.

## 1. Load balancing

**What:** Spread requests across several identical servers so no single one is the bottleneck, and so one dying doesn't take you down.

Technically, it can be a server with a specific software and configuration that works as an intermediatry between client and application service replicas/clonesand devides the request load based on defined algorithms 

**Algorithms**
- *Round robin:* rotate through servers. Simple, fair when requests cost about the same.
- *Least connections:* send to the server with the fewest in-flight requests. Better when costs vary.
- *IP hash / sticky sessions:* same client, same server. Useful for in-memory state, but uneven and it hurts failover.

**Costs:** The balancer itself must not become a single point of failure (run two, with a floating IP or DNS). Servers should be stateless, otherwise balancing gets hard. Layer 4 (TCP) is faster; layer 7 (HTTP) can route by path or header.

**Test yourself**
- Why can round robin overload one server even though it is "fair"?
- What happens to user sessions stored in a server's memory when that server dies?
- Layer 4 vs layer 7: when would you pick each?

## 2. Caching

**What:** Keep copies of expensive results in fast storage (Redis, memory) to cut latency and database load.

**Patterns**
- *Cache-aside:* app checks cache, falls back to the database, then fills the cache. Most common.
- *Write-through:* write to cache and database together. Reads stay fresh; writes cost more.
- *Write-behind:* write to cache, flush to the database later. Fast, but you can lose data.
- *TTL and eviction (LRU):* how entries expire. Redis here is capped at 64 MB with LRU.

**Failure modes you saw:** cache stampede (many misses at once), stale data after invalidation, and caches hiding a database problem until they are cold.

**Costs:** "There are only two hard things in computer science: cache invalidation and naming things." You trade freshness and simplicity for speed.

**Test yourself**
- Walk through what happens when a hot key expires under heavy traffic. Name two fixes.
- When is a short TTL better than explicit invalidation?
- What is a cache penetration attack (requests for keys that never exist), and how do you stop it?

## 3. Read replicas

**What:** Copies of the primary database that serve reads. Writes still go to the primary and stream to replicas.

**Why:** Most apps read far more than they write, so replicas scale reads and add a failover candidate.

**Costs:**
- *Replication lag* makes replicas eventually consistent. A user can save something and not see it.
- Replicas don't scale writes. Past a point you need sharding.
- Async replication can lose the most recent writes if the primary dies before they ship.

**Fixes for lag:** read-your-writes routing (read from the primary right after a write), sticky routing, or sync replication (slower writes).

**Test yourself**
- Sync vs async replication: what does each trade away?
- A user updates their profile and refreshes: what do they see, and how would you fix it?
- Why does a replica not help a write-heavy workload?

## 4. Sharding

**What:** Split data across multiple databases, each holding a slice, chosen by a shard key.

**Why:** When one machine can't hold the data or handle the write volume, even with replicas.

**Routing strategies**
- *Hash(key) % N:* simple and even, but changing N moves most keys.
- *Consistent hashing:* keys and shards sit on a ring; adding a shard moves only a small share of keys.
- *Range / directory based:* easy range queries, risk of hot spots.

**Costs:**
- Cross-shard queries and joins are slow and complex (you saw scatter-gather).
- Transactions across shards are hard.
- A bad shard key creates hot shards (for example, sharding by country or by timestamp).
- Resharding is operationally painful. Avoid sharding until you need it.

**Test yourself**
- Why did `% N` move so many more keys than the ring?
- How would you shard a social network's posts? What would make a bad key?
- How do you handle a "celebrity" key that gets 1000x the traffic?

## 5. Message queues

**What:** A buffer between producers and consumers. The producer drops a message and moves on; workers process it later.

**Why:** Decouple services, absorb traffic spikes, retry safely, and keep slow work off the request path.

**Ideas**
- *Competing consumers:* scale workers horizontally; each message is handled once.
- *Acknowledgements:* a message is only removed after the worker acks. A crash means redelivery.
- *Dead-letter queue:* poison messages are parked instead of retried forever.
- *Fan-out (pub/sub):* one event, many independent subscribers.

**Costs:**
- Delivery is usually *at-least-once*, so consumers must be **idempotent**.
- Ordering is only guaranteed in limited cases.
- Results become asynchronous: the user is told "accepted", not "done".
- The queue is more infrastructure to run and monitor (watch queue depth).

**Test yourself**
- Why is exactly-once delivery so hard, and how do idempotency keys help?
- What does prefetch=1 change, and why?
- Queue vs log (RabbitMQ vs Kafka): when would you pick each?

## 6. API gateway

**What:** One entry point in front of your services that handles cross-cutting concerns once instead of in every service.

**Typical jobs:** authentication, rate limiting, routing, request logging and tracing, TLS termination, response caching, request/response transformation.

**Rate limiting algorithms**
- *Token bucket* (used here): allows bursts, enforces an average rate.
- *Fixed window:* simple but allows 2x bursts at window boundaries.
- *Sliding window:* smoother, more bookkeeping.

**Circuit breaker:** closed → open after repeated failures → half-open probe → closed. It stops a failing dependency from soaking up threads and timeouts, and gives it room to recover.

**Costs:** The gateway is on the critical path and a potential single point of failure. Keep it thin; business logic does not belong there. Decide whether the limiter fails open or closed when its store is down.

**Test yourself**
- Why must the token bucket update be atomic when running many gateway instances?
- Fail open vs fail closed for the rate limiter: pick one for a public API and for a payments API.
- What problem does a circuit breaker solve that a timeout alone does not?

## 7. CDN

**What:** A network of edge caches near users. Static (and sometimes dynamic) content is served from the nearest edge instead of your origin.

**Why:** Lower latency, less origin load, absorbs traffic spikes and some DDoS.

**Ideas**
- *Cache-Control and TTL* tell the edge how long a copy is valid.
- *Cache busting:* versioned filenames (`app.3f9c1.js`) so a deploy gets a new URL.
- *Request collapsing:* one origin fetch for many simultaneous misses.
- *Stale-while-revalidate / stale-if-error:* keep serving during refresh or outages.

**Costs:** Invalidating content worldwide is slow and sometimes costly; personalized content is hard to cache; the cache key must be right or users see each other's data.

**Test yourself**
- How do you ship an urgent fix to a JS file that is cached for a year?
- What belongs in a cache key, and what happens if you leave out a `Vary` header?
- Push vs pull CDN: what is the difference?

## Putting it together

A typical request path in a large system:

`client → CDN → API gateway → load balancer → app server → cache → read replica (or primary for writes) → shard`, with slow work going through a **queue** to workers.

For any system design interview, a useful routine is:
1. Clarify requirements and scale (reads vs writes, latency, consistency needs).
2. Start with one server and one database.
3. Add each component above **only when a specific bottleneck demands it**, and say which trade-off you are accepting.
