// Sharding: key routing, even distribution, resharding cost, and scatter-gather.
import { get, lesson, post, requireStack, step, title, LB } from "./lib.js";

await requireStack();
title("Sharding");
await post(`${LB}/shards/reset`);

step("Insert 10,000 users, routed to 2 shard databases by hashing the user id");
const bulk = await post(`${LB}/shards/users/bulk?start=1&count=10000`);
console.log("  per shard:", bulk.body.per_shard);
const dist = (await get(`${LB}/shards/distribution`)).body;
console.log(`  strategy=${dist.strategy}`);
for (const s of dist.shards) console.log(`  shard ${s.shard}: ${s.rows} rows (${Math.round(s.share * 100)}%)`);
lesson("A good hash function spreads keys evenly, so no single database holds all the data or traffic.");

step("Point lookups go to exactly one shard");
for (const id of [42, 4242, 9999]) {
  const r = await get(`${LB}/shards/users/${id}`);
  console.log(`  user ${id} -> shard ${r.body.shard}`);
}
lesson("Querying by the shard key is cheap: one hop, one database.");

step("Scatter-gather: top 5 users by id with no shard key to route on");
const top = await get(`${LB}/shards/users/top?limit=5`);
console.log(`  had to query ${top.body.queried_shards} shards, merged ids:`, top.body.rows.map((r: { id: number }) => r.id));
lesson("Queries that do not include the shard key must hit every shard and merge results. Joins and global sorts get painful.");

step("Resharding cost: what fraction of keys must move when the shard count changes?");
console.log("  change      mod(N)    consistent-hash   theoretical minimum");
for (const [from, to] of [[2, 3], [3, 4], [9, 10], [4, 8]]) {
  const s = (await get(`${LB}/shards/simulate?keys=20000&from_n=${from}&to_n=${to}`)).body;
  console.log(
    `  ${from} -> ${to}`.padEnd(12) +
      `${Math.round(s.moved_with_mod * 100)}%`.padEnd(10) +
      `${Math.round(s.moved_with_consistent_hash * 100)}%`.padEnd(18) +
      `${Math.round(s.theoretical_minimum * 100)}%`,
  );
}
lesson(
  "hash(key) % N reshuffles most keys when N changes, which means a huge data migration. A " +
    "consistent-hash ring moves only about the minimum. Compare by restarting with SHARD_STRATEGY=mod.",
);
