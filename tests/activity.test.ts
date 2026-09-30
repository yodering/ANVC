/**
 * The activity log, and the receipt a person sees in the terminal.
 *
 * The receipt is the one place a person learns anvc did anything, so it must
 * speak when something happened, stay silent when nothing did, and never say
 * the same thing twice.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logActivity, readActivity, receipt, repoRoot, type Activity } from "../protocol/activity";
import { appendRecord, ulid, type CheckpointRecord } from "../protocol/record";
import { git, gitRepo, rpc, runHook, tmp } from "./helpers";

const row = (over: Partial<Activity>): Activity => ({ ts: new Date().toISOString(), kind: "injected", repo: "/r", session: "s", ...over });

test("a quiet turn gets no receipt", () => {
  expect(receipt([])).toBeNull();
  expect(receipt([row({ kind: "nudged" })])).toBeNull();
});

test("a receipt counts what was shown, searched, opened and recorded, and names what was opened", () => {
  const text = receipt([
    row({ kind: "injected", records: ["A", "B"], titles: ["Cache the ref index", "Pool redis"] }),
    row({ kind: "searched", records: ["B"], titles: ["Pool redis"] }),
    row({ kind: "opened", records: ["A"] }),
    row({ kind: "recorded", outcome: "abandoned", tier: "shared", records: ["C"] }),
  ])!;
  expect(text).toContain("showed 2 past attempts");
  expect(text).toContain("the agent searched once");
  expect(text).toContain("opened 1 record in full");
  expect(text).toContain("recorded abandoned attempt (shared)");
  // What the agent opened is named first: asking for more is the strongest
  // sign a record mattered.
  expect(text.split("\n")[1]).toContain('"Cache the ref index"');
});

test("repoRoot is the same from a worktree as from the main checkout", async () => {
  const repo = gitRepo({ commit: true });
  const tree = join(tmp("anvc-root-wt-"), "wt");
  git(repo, "worktree", "add", "-q", tree);
  // The raw log keyed events by worktree folder, so a worktree's history was
  // invisible from the main checkout.
  expect(repoRoot(tree)).toBe(repoRoot(repo));
});

test("the stop hook shows a receipt once, and stays silent after", async () => {
  const repo = gitRepo();
  const state = tmp("anvc-receipt-state-");
  const transcript = join(state, "t.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
  const root = repoRoot(repo)!;
  logActivity({ kind: "injected", repo: root, session: "s-receipt", records: ["X"], titles: ["Cache the ref index"] });

  const stop = () => runHook("stop", "Stop", { hook_event_name: "Stop", session_id: "s-receipt", cwd: repo, transcript_path: transcript }, { ANVC_STATE_DIR: state });
  const first = stop();
  expect(first?.systemMessage).toContain("showed 1 past attempt");
  expect(first?.systemMessage).toContain("Cache the ref index");
  // Nothing new since: a receipt that repeats is one people stop reading.
  expect(stop()).toBeNull();
});

test("an agent's search through the MCP server reaches the activity log, with ids", async () => {
  const repo = gitRepo({ bare: true });
  const record = {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "s" },
    intent: { goal: "Cache the ref index in memory" },
    outcome: { status: "abandoned", recheck: null, errors: ["stale after write"] },
    ts: new Date().toISOString(),
  } as CheckpointRecord;
  appendRecord(repo, record);
  await rpc(repo, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "anvc_tried", arguments: { query: "cache" } } },
  ], { ANVC_SESSION: "s-mcp-activity" });
  const rows = readActivity({ session: "s-mcp-activity", kinds: ["searched"] });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.query).toBe("cache");
  expect(rows[0]!.records).toEqual([record.id]);
  expect(rows[0]!.titles?.[0]).toContain("Cache the ref index");
});
