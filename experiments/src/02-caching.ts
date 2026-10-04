// Caching: cache-aside speedup, cache stampede, and the stale-cache trap with replicas.
import { avg, del, get, lesson, post, put, requireStack, round, sleep, step, title, LB } from "./lib.js";

await requireStack();
title("Caching");
await post(`${LB}/admin/replica/resume`);
await del(`${LB}/cache`);
await post(`${LB}/stats/reset`);

async function dbHits(): Promise<number> {
  return (await get(`${LB}/stats`)).body.db_hits;
}

step("10 reads with NO cache vs 10 reads with cache-aside (product 1)");
const noCache = [];
for (let i = 0; i < 10; i++) noCache.push((await get(`${LB}/products/1?strategy=none`)).ms);
const cached = [];
const labels: string[] = [];
for (let i = 0; i < 10; i++) {
  const r = await get(`${LB}/products/1?strategy=cache-aside`);
  cached.push(r.ms);
  labels.push(r.headers.get("x-cache") ?? "?");
}
console.log(`  no cache:    avg ${round(avg(noCache))} ms`);
console.log(`  cache-aside: avg ${round(avg(cached))} ms   [${labels.join(" ")}]`);
lesson("First read is a MISS and pays the full cost. Every later read is a HIT served from memory.");

step("Cache stampede: 30 concurrent requests for a key that just expired");
await del(`${LB}/cache`);
await post(`${LB}/stats/reset`);
await Promise.all(Array.from({ length: 30 }, () => get(`${LB}/products/2?strategy=cache-aside`)));
const stampedeHits = await dbHits();
console.log(`  plain cache-aside: database queries = ${stampedeHits}`);

await del(`${LB}/cache`);
await post(`${LB}/stats/reset`);
await Promise.all(Array.from({ length: 30 }, () => get(`${LB}/products/2?strategy=lock`)));
console.log(`  with a lock:       database queries = ${await dbHits()}`);
lesson(
  "All 30 requests missed at once and all 30 hit the database. A Redis lock lets one request " +
    "rebuild the entry while the rest wait. At real traffic this is what takes databases down.",
);

step("Stale cache trap: invalidate-on-write combined with a lagging replica");
await del(`${LB}/cache`);
const before = (await get(`${LB}/products/3`)).body.product.price_cents;
await post(`${LB}/admin/replica/pause`);
await put(`${LB}/products/3`, { price_cents: 99999 });
const afterWrite = await get(`${LB}/products/3`);
console.log(`  price before: ${before}, wrote 99999, read back: ${afterWrite.body.product.price_cents} (from ${afterWrite.body.source})`);
await post(`${LB}/admin/replica/resume`);
await sleep(1000);
const later = await get(`${LB}/products/3`);
console.log(`  replica caught up, but a read now returns ${later.body.product.price_cents} (from ${later.body.source})`);
lesson(
  "The cache was invalidated, then refilled from a stale replica, so the old price is now cached " +
    "for 30s even though the database is correct. Layers interact in surprising ways.",
);

step("Fix: write-through puts the new value straight into the cache");
await put(`${LB}/products/3?mode=write-through`, { price_cents: 12345 });
const fixed = await get(`${LB}/products/3`);
console.log(`  read after write-through: ${fixed.body.product.price_cents} (from ${fixed.body.source})`);
lesson("Trade-off: write-through keeps reads fresh but every write now touches two systems.");
