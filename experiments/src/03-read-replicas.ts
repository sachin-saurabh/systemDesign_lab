// Read replicas: replication lag, read-your-writes, and eventual consistency.
import { get, lesson, post, requireStack, sleep, step, title, LB } from "./lib.js";

await requireStack();
title("Read replicas");
await post(`${LB}/admin/replica/resume`);

step("Replica status");
console.log(" ", (await get(`${LB}/replica/status`)).body);
lesson("is_replica=true means this database is a read-only copy streaming changes from the primary.");

step("Write a note to the primary, then read it from the replica immediately (10 tries)");
let stale = 0;
for (let i = 0; i < 10; i++) {
  const { body } = await post(`${LB}/notes`, { body: `hello ${i}` });
  const r = await get(`${LB}/notes/${body.id}?source=replica`);
  if (r.status === 404) stale++;
}
console.log(`  stale reads: ${stale} of 10`);
lesson("On a local network replication is usually a few milliseconds, so you may see 0. Next we make the lag visible.");

step("Pause replication on the replica, then write");
await post(`${LB}/admin/replica/pause`);
const { body: written } = await post(`${LB}/notes`, { body: "written while replica is paused" });
const fromReplica = await get(`${LB}/notes/${written.id}?source=replica`);
const fromPrimary = await get(`${LB}/notes/${written.id}?source=primary`);
console.log(`  replica -> HTTP ${fromReplica.status}   primary -> HTTP ${fromPrimary.status}`);
console.log(" ", (await get(`${LB}/replica/status`)).body);
lesson(
  "The replica is behind: a user who just saved something would not see it. This is replication " +
    "lag, and it is why replicas give you eventual consistency, not instant consistency.",
);

step("Resume replication and time how long until the row appears");
const started = performance.now();
await post(`${LB}/admin/replica/resume`);
for (;;) {
  const r = await get(`${LB}/notes/${written.id}?source=replica`);
  if (r.status === 200) break;
  await sleep(20);
}
console.log(`  visible on replica after ${Math.round(performance.now() - started)} ms`);

lesson(
  "Common fix, read-your-writes: after a user writes, send THEIR next reads to the primary for a " +
    "short window (or until the replica's position passes their write). Everyone else reads from replicas.",
);
