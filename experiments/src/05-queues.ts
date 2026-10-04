// Message queues: async decoupling, competing consumers, dead-letter queue, fan-out.
import { avg, get, lesson, post, requireStack, round, sleep, step, title, LB } from "./lib.js";

await requireStack();
title("Message queues");
await post(`${LB}/queue/purge`);
await post(`${LB}/stats/reset`);

step("5 orders processed inline (the request waits for the slow work)");
const syncTimes = [];
for (let i = 0; i < 5; i++) syncTimes.push((await post(`${LB}/orders/sync`, { item: "widget" })).ms);
console.log(`  avg response: ${round(avg(syncTimes))} ms`);

step("5 orders via the queue (the request only enqueues)");
const asyncTimes = [];
for (let i = 0; i < 5; i++) asyncTimes.push((await post(`${LB}/orders`, { item: "widget" })).ms);
console.log(`  avg response: ${round(avg(asyncTimes))} ms  (HTTP 202 Accepted)`);
lesson("The user gets an answer immediately; the slow work happens in the background, off the request path.");

await sleep(3000);
await post(`${LB}/stats/reset`);

step("Burst of 30 orders; every 10th is poisoned and will fail");
const burstStart = performance.now();
await Promise.all(
  Array.from({ length: 30 }, (_, i) => post(`${LB}/orders`, { item: "widget", fail: (i + 1) % 10 === 0 })),
);
console.log(`  all 30 accepted in ${Math.round(performance.now() - burstStart)} ms`);

step("Watching the workers drain the queue");
const drainStart = performance.now();
let stats = (await get(`${LB}/queue/stats`)).body;
for (let i = 0; i < 120 && stats.processed + stats.failed < 30; i++) {
  await sleep(500);
  stats = (await get(`${LB}/queue/stats`)).body;
  console.log(`  waiting=${stats.waiting_in_orders} processed=${stats.processed} failed=${stats.failed}`);
}
console.log(`  drained in ${((performance.now() - drainStart) / 1000).toFixed(1)}s`);
console.log("  work split by consumer:", stats.by_consumer);
console.log("  dead-lettered messages:", stats.dead_lettered);
console.log("  event copies delivered (fan-out):", stats.events_delivered);
lesson(
  "1) Backlog absorbs bursts. 2) Failed messages land in the dead-letter queue instead of blocking or " +
    "looping forever. 3) The fan-out exchange gave email AND analytics their own copy of every event. " +
    "Now run: docker compose up -d --scale worker=3, then re-run and compare the drain time.",
);
console.log("\n   RabbitMQ UI: http://localhost:15672  (user: lab, password: see docker-compose.yml / .env)");
