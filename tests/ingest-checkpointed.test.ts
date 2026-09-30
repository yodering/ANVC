/**
 * A turn the agent already checkpointed is not scraped a second time.
 *
 * Found on a fresh install: one Haiku session edited greet.ts and called
 * anvc_checkpoint, then `anvc ingest` wrote a scraped record for the same turn,
 * and the work log listed the attempt twice.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ingest, type CaptureEvent } from "../protocol/ingest";
import { appendRecord, listRecords } from "../protocol/record";
import { gitRepo, rec } from "./helpers";

const at = (s: number) => new Date(Date.UTC(2026, 8, 26, 17, 0, s)).toISOString();

/** Two turns in one session: prompt, edit, stop; then prompt, edit, stop. */
function twoTurns(repo: string): CaptureEvent[] {
  const base = { anvc_capture: 0 as const, repo, cwd: repo, session_id: "sess-a",
    tool: null, path: null, command: null, bytes: null, prompt: null, ok: null };
  return [
    { ...base, event: "UserPromptSubmit", ts: at(0), prompt: "add a greeting parameter" },
    { ...base, event: "PostToolUse", ts: at(5), tool: "Edit", path: `${repo}/greet.ts`, bytes: 90, ok: true },
    { ...base, event: "Stop", ts: at(10) },
    { ...base, event: "UserPromptSubmit", ts: at(20), prompt: "now a farewell" },
    { ...base, event: "PostToolUse", ts: at(25), tool: "Edit", path: `${repo}/bye.ts`, bytes: 90, ok: true },
    { ...base, event: "Stop", ts: at(30) },
  ] as CaptureEvent[];
}

const checkpoint = (session: string, ts: string) =>
  rec({ session: { agent: "claude-code", run_id: session }, intent: { goal: "Add a greeting parameter" }, ts });

async function withRepo(fn: (repo: string) => void | Promise<void>) {
  const repo = gitRepo();
  await writeFile(join(repo, "greet.ts"), "");
  await writeFile(join(repo, "bye.ts"), "");
  await fn(repo);
}

test("a turn with a checkpoint from its own session is skipped; the next turn is not", () =>
  withRepo((repo) => {
    appendRecord(repo, checkpoint("sess-a", at(8)));
    const result = ingest(repo, twoTurns(repo));
    expect(result.written).toBe(1);
    expect(listRecords(repo)).toHaveLength(2);
  }));

test("a checkpoint from another session covers nothing", () =>
  withRepo((repo) => {
    appendRecord(repo, checkpoint("sess-b", at(8)));
    expect(ingest(repo, twoTurns(repo)).written).toBe(2);
  }));

test("a checkpoint after the last prompt covers the last turn", () =>
  withRepo((repo) => {
    // The stop hook asks for a checkpoint after the first Stop, so it can land
    // after every captured event of the turn.
    appendRecord(repo, checkpoint("sess-a", at(45)));
    expect(ingest(repo, twoTurns(repo)).written).toBe(1);
  }));
