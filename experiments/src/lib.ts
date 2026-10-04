// Small helpers shared by the experiments.

export const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
export const LB = process.env.LB_URL ?? "http://localhost:8081";
export const CDN = process.env.CDN_URL ?? "http://localhost:8082";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Reply = {
  status: number;
  ms: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
};

export async function call(url: string, init: RequestInit & { json?: unknown } = {}): Promise<Reply> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const started = performance.now();
  const res = await fetch(url, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const ms = performance.now() - started;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON, keep the raw text
  }
  return { status: res.status, ms, headers: res.headers, body };
}

export const get = (url: string, headers?: Record<string, string>) => call(url, { headers });
export const post = (url: string, json?: unknown, headers?: Record<string, string>) =>
  call(url, { method: "POST", json, headers });
export const put = (url: string, json: unknown) => call(url, { method: "PUT", json });
export const del = (url: string) => call(url, { method: "DELETE" });

export function tally(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
export const round = (n: number, digits = 0) => Number(n.toFixed(digits));

export function bar(n: number, max: number, width = 30): string {
  return "#".repeat(Math.round((n / Math.max(max, 1)) * width));
}

export function printTally(counts: Record<string, number>): void {
  const max = Math.max(...Object.values(counts), 1);
  for (const [key, n] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(12)} ${String(n).padStart(4)}  ${bar(n, max)}`);
  }
}

export const title = (text: string) => console.log(`\n=== ${text} ===`);
export const step = (text: string) => console.log(`\n-- ${text}`);
export const lesson = (text: string) => console.log(`\n   >> ${text}`);

export async function requireStack(): Promise<void> {
  try {
    const res = await fetch(`${LB}/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`Cannot reach the lab at ${LB}. Start it first: docker compose up -d --build`);
    process.exit(1);
  }
}
