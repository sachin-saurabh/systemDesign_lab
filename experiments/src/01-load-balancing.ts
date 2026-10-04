// Load balancing: round robin, why request cost matters, and surviving a dead server.
//   npm run 01            distribution + heavy-request experiment
//   npm run 01 -- --chaos also stops api2 mid-run (needs docker compose on this machine)
import { execSync } from "node:child_process";
import path from "node:path";
import { LB, get, lesson, printTally, requireStack, sleep, step, tally, title } from "./lib.js";

await requireStack();
title("Load balancing");

step("40 sequential requests to /whoami through nginx");
const served: string[] = [];
for (let i = 0; i < 40; i++) served.push((await get(`${LB}/whoami`)).headers.get("x-served-by") ?? "?");
printTally(tally(served));
lesson("Round robin spreads equal-cost requests evenly. The balancer is stateless and cheap.");

step("60 requests where every 3rd one is HEAVY (holds its connection for 1.5s)");
const heavyServers: string[] = [];
const inFlight: Promise<void>[] = [];
for (let i = 0; i < 60; i++) {
  const heavy = i % 3 === 0;
  inFlight.push(
    get(`${LB}/slow?ms=${heavy ? 1500 : 20}`).then((r) => {
      if (heavy) heavyServers.push(r.headers.get("x-served-by") ?? "?");
    }),
  );
  await sleep(10); // small stagger so the dispatch order is deterministic
}
await Promise.all(inFlight);
console.log("  Where the 20 heavy requests landed:");
printTally(tally(heavyServers));
lesson(
  "With plain round robin and 3 servers, every 3rd request hits the SAME server, so one server " +
    "can receive all the heavy work. Try: LB_CONF=lb.least_conn.conf docker compose up -d lb, " +
    "then run this again. Least-connections sends new work to whoever is least busy.",
);

if (process.argv.includes("--chaos")) {
  const root = path.resolve(import.meta.dirname, "..", "..");
  step("CHAOS: stopping api2, then sending 30 requests");
  execSync("docker compose stop api2", { cwd: root, stdio: "inherit" });
  const results = [];
  for (let i = 0; i < 30; i++) results.push(await get(`${LB}/whoami`));
  console.log("  HTTP statuses:", tally(results.map((r) => String(r.status))));
  printTally(tally(results.map((r) => r.headers.get("x-served-by") ?? "?")));
  lesson("Zero errors: nginx noticed api2 was gone and retried on the others (proxy_next_upstream).");

  step("Bringing api2 back");
  execSync("docker compose start api2", { cwd: root, stdio: "inherit" });
  await sleep(5000);
  execSync("docker compose exec -T lb nginx -s reload", { cwd: root, stdio: "inherit" });
  lesson("Production load balancers run active health checks so recovered servers rejoin automatically.");
}
