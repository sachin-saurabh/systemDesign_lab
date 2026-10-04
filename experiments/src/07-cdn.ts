// CDN: edge caching, request collapsing, and cache busting with versioned URLs.
import { CDN, LB, avg, get, lesson, requireStack, round, step, tally, title } from "./lib.js";

await requireStack();
title("CDN");

const run = Date.now();

step("Origin direct (through the load balancer): 3 requests");
const origin = [];
for (let i = 0; i < 3; i++) origin.push((await get(`${LB}/assets/app.js?v=origin-${run}-${i}`)).ms);
console.log(`  each ~${round(avg(origin))} ms (the origin is deliberately slow: 300ms)`);

step("Through the CDN edge: 4 requests for the same file");
for (let i = 0; i < 4; i++) {
  const r = await get(`${CDN}/assets/app.js?v=${run}`);
  console.log(`  request ${i + 1}: ${String(Math.round(r.ms)).padStart(4)} ms   X-Cache-Status=${r.headers.get("x-cache-status")}`);
}
lesson("First request is a MISS (goes to the origin). After that the edge answers on its own, in a few milliseconds.");

step("Request collapsing: 20 simultaneous requests for a brand-new file");
const burst = await Promise.all(Array.from({ length: 20 }, () => get(`${CDN}/assets/app.js?v=burst-${run}`)));
console.log("  X-Cache-Status:", tally(burst.map((r) => r.headers.get("x-cache-status") ?? "?")));
console.log(`  slowest: ${Math.round(Math.max(...burst.map((r) => r.ms)))} ms`);
lesson("nginx's proxy_cache_lock sends ONE request to the origin and makes the rest wait for it, protecting the origin from a stampede.");

step("Cache busting: ship a new version by changing the URL");
for (const version of [`v2-${run}`, `v2-${run}`]) {
  const r = await get(`${CDN}/assets/app.js?v=${version}`);
  console.log(`  ?v=${version.slice(0, 2)} -> ${Math.round(r.ms)} ms  ${r.headers.get("x-cache-status")}`);
}
lesson(
  "You cannot easily recall a copy cached on edges around the world. So static files get long TTLs and " +
    "versioned URLs (app.3f9c1.js): a new URL is a new cache entry, and old copies simply stop being asked for.",
);
