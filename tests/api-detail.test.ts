/**
 * The dense half of a record — verbatim output, what was ruled out, what was
 * never checked — was stored and validated but dropped by the API, so the UI
 * could not show it. These pin it to the work view.
 */
import { expect, test } from "bun:test";
import { appendRecord, type CheckpointRecord } from "../protocol/record";
import { repoView } from "../server/api";
import { gitRepo, rec } from "./helpers";

function repoWith(record: Partial<CheckpointRecord>) {
  const repo = gitRepo({ commit: true });
  appendRecord(repo, rec({
    intent: { goal: "Share one SSLContext" },
    outcome: { status: "abandoned", errors: ["races under load"], recheck: null },
    ...record,
  }));
  return repo;
}

test("the work view carries the dense half and the recheck command", () => {
  const repo = repoWith({
    outcome: { status: "abandoned", errors: ["races under load"], recheck: "bun test tests/ssl.test.ts" },
    detail: {
      output: "ssl.SSLError: no certificate or crl found",
      ruled_out: [{ approach: "a lock around the context", because: "held for the whole handshake" }],
      not_investigated: ["a pool sized to the worker count"],
    },
  });
  const [turn] = repoView(repo).turns;
  expect(turn!.recheck).toBe("bun test tests/ssl.test.ts");
  expect(turn!.detail?.output).toContain("SSLError");
  expect(turn!.detail?.ruled_out?.[0]?.approach).toBe("a lock around the context");
  expect(turn!.detail?.not_investigated).toEqual(["a pool sized to the worker count"]);
}, 30_000);

test("a record without a dense half has no detail, not an empty one", () => {
  const repo = repoWith({});
  const [turn] = repoView(repo).turns;
  expect(turn!.detail).toBeNull();
  expect(turn!.recheck).toBeNull();
}, 30_000);

test("a dead end is open until something retries or replaces it, and a replaced row names its successor", () => {
  const repo = gitRepo({ commit: true });
  const at = (h: number) => `2026-09-20T${String(h).padStart(2, "0")}:00:00.000Z`;
  const abandoned = { status: "abandoned" as const, errors: ["no"], recheck: null };
  const wall = rec({ ts: at(1), intent: { goal: "retried wall" }, outcome: abandoned });
  const open = rec({ ts: at(2), intent: { goal: "open wall" }, outcome: abandoned });
  const old = rec({ ts: at(3), intent: { goal: "old claim" }, outcome: abandoned });
  const retry = rec({ ts: at(4), intent: { goal: "retry" }, parent: wall.id });
  const fix = rec({ ts: at(5), intent: { goal: "new claim" }, supersedes: old.id });
  for (const r of [wall, open, old, retry, fix]) appendRecord(repo, r as CheckpointRecord);
  const rows = new Map(repoView(repo).turns.map((t) => [t.intent, t]));
  expect(rows.get("retried wall")!.openDeadEnd).toBe(false);
  expect(rows.get("open wall")!.openDeadEnd).toBe(true);
  expect(rows.get("old claim")!.openDeadEnd).toBe(false);
  expect(rows.get("old claim")!.replacedBy).toBe(fix.id);
  expect(rows.get("new claim")!.supersedes).toBe(old.id);
  // The page shows the latest ones; the rest are a click away.
  expect(repoView(repo, 2).turns.map((t) => t.intent)).toEqual(["new claim", "retry"]);
}, 30_000);
