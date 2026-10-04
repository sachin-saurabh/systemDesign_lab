/**
 * API gateway: the single front door for clients.
 *
 * Request path:  client -> [request id] -> [auth] -> [rate limit] -> [circuit breaker] -> upstream
 *
 * Everything under /api/* is forwarded to the upstream (our nginx load balancer) with the
 * /api prefix stripped. /health and /gateway/state are answered by the gateway itself.
 */
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { Redis } from "ioredis";

const PORT = Number(process.env.PORT ?? 3000);
const UPSTREAM = process.env.UPSTREAM ?? "http://localhost:8081";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/0";
const UPSTREAM_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// API keys and their rate-limit plans. API_KEYS="key:capacity:refillPerSec,..."
// ---------------------------------------------------------------------------
type Plan = { capacity: number; refillPerSec: number };
const plans = new Map<string, Plan>();
for (const entry of (process.env.API_KEYS ?? "").split(",").filter(Boolean)) {
  const [key, capacity, refill] = entry.split(":");
  plans.set(key, { capacity: Number(capacity), refillPerSec: Number(refill) });
}

// ---------------------------------------------------------------------------
// Rate limiting: token bucket in Redis.
// The bucket holds up to `capacity` tokens and refills continuously. Each request spends
// one. A Lua script makes read-modify-write atomic, so many gateway instances can share
// one bucket without races.
// ---------------------------------------------------------------------------
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + (math.max(0, now - ts) / 1000.0) * refill)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000) + 1000)
return {allowed, tostring(tokens)}
`;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on("error", (err) => console.error("redis error:", err.message));

// ---------------------------------------------------------------------------
// Circuit breaker: stop hammering an upstream that is failing.
//   closed    -> normal; count consecutive failures
//   open      -> fail fast with 503 for `cooldownMs`, giving the upstream room to recover
//   half-open -> let ONE trial request through; success closes, failure re-opens
// ---------------------------------------------------------------------------
class CircuitBreaker {
  state: "closed" | "open" | "half-open" = "closed";
  failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 10_000,
  ) {}

  canRequest(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.cooldownMs) return false;
      this.state = "half-open";
      this.trialInFlight = false;
    }
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.failures += 1;
    this.trialInFlight = false;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

const breaker = new CircuitBreaker();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = req.header("x-request-id") ?? randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - started,
        breaker: breaker.state,
      }),
    );
  });
  next();
});

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("x-api-key");
  if (!key) {
    res.status(401).json({ error: "missing x-api-key header" });
    return;
  }
  if (!plans.has(key)) {
    res.status(403).json({ error: "unknown api key" });
    return;
  }
  res.locals.apiKey = key;
  next();
}

async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = res.locals.apiKey as string;
  const plan = plans.get(key)!;
  try {
    const [allowed, tokens] = (await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      `rl:${key}`,
      plan.capacity,
      plan.refillPerSec,
      Date.now(),
    )) as [number, string];
    const remaining = Math.max(0, Math.floor(Number(tokens)));
    res.setHeader("x-ratelimit-limit", String(plan.capacity));
    res.setHeader("x-ratelimit-remaining", String(remaining));
    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil((1 - Number(tokens)) / plan.refillPerSec));
      res.setHeader("retry-after", String(retryAfter));
      res.status(429).json({ error: "rate limit exceeded", retryAfterSeconds: retryAfter });
      return;
    }
  } catch (err) {
    // Design choice: if Redis is down we fail OPEN (let traffic through) rather than
    // taking the whole API down with the limiter. Some systems prefer to fail closed.
    console.error("rate limiter unavailable, failing open:", (err as Error).message);
  }
  next();
}

const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "x-served-by", "x-cache"];

async function proxy(req: Request, res: Response): Promise<void> {
  if (!breaker.canRequest()) {
    res.status(503).json({ error: "circuit open: upstream is failing, failing fast", breaker: breaker.state });
    return;
  }

  const headers: Record<string, string> = {
    "x-request-id": res.locals.requestId as string,
    "x-forwarded-for": req.ip ?? "",
  };
  for (const name of ["content-type", "accept"]) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  const hasBody = !["GET", "HEAD"].includes(req.method) && req.body && Object.keys(req.body).length > 0;

  try {
    const upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // 5xx means the upstream is unhealthy. 4xx is the client's fault, so it doesn't count.
    if (upstream.status >= 500) breaker.onFailure();
    else breaker.onSuccess();

    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("x-gateway", "ts-gateway");
    res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    breaker.onFailure();
    res.status(504).json({ error: "upstream unreachable or timed out", detail: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/gateway/state", (_req, res) => {
  res.json({ breaker: breaker.state, consecutiveFailures: breaker.failures });
});

app.use("/api", authenticate, rateLimit, proxy);

app.listen(PORT, () => {
  console.log(`gateway listening on :${PORT}, upstream ${UPSTREAM}, ${plans.size} api keys loaded`);
});
