// API gateway: authentication, rate limiting (token bucket), and a circuit breaker.
// Takes about 25 seconds because it waits out the breaker's cooldown.
import { GATEWAY, call, get, lesson, requireStack, sleep, step, tally, title } from "./lib.js";

await requireStack();
title("API gateway");

const FREE = { "x-api-key": "free-key" }; // bucket of 5, refills 1 per second
const PRO = { "x-api-key": "pro-key" }; //   bucket of 50, refills 10 per second

step("Authentication");
console.log("  no key      ->", (await get(`${GATEWAY}/api/whoami`)).status);
console.log("  wrong key   ->", (await get(`${GATEWAY}/api/whoami`, { "x-api-key": "nope" })).status);
const ok = await get(`${GATEWAY}/api/whoami`, FREE);
console.log("  valid key   ->", ok.status, ok.body);
lesson("401 = who are you? 403 = I know you, but no. The gateway rejects bad traffic before it touches any backend.");

step("Rate limiting: 12 rapid requests with the free key");
await sleep(6000); // let the bucket refill completely
const burst = [];
for (let i = 0; i < 12; i++) burst.push((await get(`${GATEWAY}/api/whoami`, FREE)).status);
console.log("  statuses:", burst.join(" "));
const limited = await get(`${GATEWAY}/api/whoami`, FREE);
console.log(`  next call: ${limited.status}, retry-after=${limited.headers.get("retry-after")}s`);
lesson("A bucket of 5 allows short bursts, then throttles to the refill rate (1/s). 429 + Retry-After tells clients when to come back.");

step("Same burst with the pro key");
const proBurst = [];
for (let i = 0; i < 12; i++) proBurst.push((await get(`${GATEWAY}/api/whoami`, PRO)).status);
console.log("  statuses:", proBurst.join(" "));
lesson("Limits are per key, so one noisy customer cannot starve the others.");

step("Circuit breaker: hammer an endpoint that always returns 500");
const failing = [];
for (let i = 0; i < 9; i++) failing.push(await get(`${GATEWAY}/api/boom`, PRO));
console.log("  statuses:", failing.map((r) => r.status).join(" "));
console.log("  latency of last call:", `${Math.round(failing[8].ms)} ms`);
console.log("  breaker:", (await call(`${GATEWAY}/gateway/state`)).body);
lesson("After 5 straight failures the breaker opens. Calls now fail instantly (503) without touching the sick backend.");

step("Waiting 11s for the cooldown, then sending a trial request that fails again");
await sleep(11_000);
const trial = await get(`${GATEWAY}/api/boom`, PRO);
const right = await get(`${GATEWAY}/api/whoami`, PRO);
console.log(`  trial /boom -> ${trial.status}   immediately after, /whoami -> ${right.status}`);
lesson("Half-open lets ONE probe through. It failed, so the breaker re-opened for another cooldown.");

step("Waiting another 11s, then a healthy request");
await sleep(11_000);
const recovered = await get(`${GATEWAY}/api/whoami`, PRO);
console.log(`  /whoami -> ${recovered.status}, breaker:`, (await call(`${GATEWAY}/gateway/state`)).body);
console.log("  summary of gateway statuses seen:", tally([...failing, trial, right, recovered].map((r) => String(r.status))));
lesson("The probe succeeded, so the breaker closed and traffic flows again, with no human involved.");
