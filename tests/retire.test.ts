/**
 * Retirement: taking a record out of what agents are shown.
 *
 * The promise is that the person decides how much an agent may do alone, that
 * nothing is deleted, and that a retired record stops being injected while
 * staying findable. Each test checks one of those against the real index.
 */
import { expect, test } from "bun:test";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PRESETS, writePolicy, type RetireMode } from "../protocol/policy";
import { buildIndex, openDeadEnds, openIndex, retirements, tried } from "../protocol/query";
import { agentRetire, personDecide } from "../protocol/retire";
import { appendRecord, ulid, validateRecord } from "../protocol/record";
import { git, gitRepo, rec } from "./helpers";

async function repo(mode: RetireMode) {
  const dir = gitRepo();
  await writeFile(join(dir, "pool.ts"), "export const pool = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "pool");
  writePolicy(dir, { preset: "team", ...structuredClone(PRESETS.team!.policy), retire: mode });
  return { dir };
}

const deadEnd = (goal: string, ts = new Date(Date.now() - 60_000)) => rec({
  id: ulid(ts.getTime()),
  intent: { goal, why: "ssl context is not copyable" },
  outcome: { status: "abandoned", recheck: "bun test" },
  delta: { files: ["pool.ts"] },
  ts: ts.toISOString(),
});

const kept = (goal: string) => rec({ intent: { goal } });

function index(dir: string) {
  const db = openIndex();
  buildIndex(db, dir);
  return db;
}

const agent = { session: "s-agent", agent: "claude-code" };

test("with retirement off, an agent cannot retire anything", async () => {
  const { dir } = await repo("off");
  const r = deadEnd("Pool the redis connections");
  appendRecord(dir, r);
  const db = index(dir);
  expect(() => agentRetire(db, dir, { target: r.id, reason: "wrong", evidence: "it works now", ...agent })).toThrow(/off/);
});

test("in ask mode an agent only proposes, and nothing changes until the person approves", async () => {
  const { dir } = await repo("ask");
  const r = deadEnd("Pool the redis connections");
  appendRecord(dir, r);
  const out = agentRetire(index(dir), dir, { target: r.id, reason: "wrong", evidence: "bun test passes with a pool", ...agent });
  expect(out.state).toBe("proposed");
  // A proposal is between this agent and this person.
  expect(out.tier).toBe("private");

  let db = index(dir);
  expect(openDeadEnds(db).map((h) => h.id)).toContain(r.id);
  expect(retirements(db).pending.map((p) => p.target)).toEqual([r.id]);

  personDecide(db, dir, r.id, "retire");
  db = index(dir);
  expect(openDeadEnds(db).map((h) => h.id)).not.toContain(r.id);
  expect(retirements(db).pending).toHaveLength(0);
});

test("in auto mode a checkable reason retires at once, and one resting on the agent's word is still a proposal", async () => {
  const { dir } = await repo("auto");
  const old = deadEnd("Pool the redis connections");
  appendRecord(dir, old);
  const newer = kept("Pool the redis connections with one context per worker");
  appendRecord(dir, newer);
  const other = deadEnd("Cache the ref index");
  appendRecord(dir, other);

  const replaced = agentRetire(index(dir), dir, { target: old.id, reason: "replaced", by: newer.id, evidence: "the newer record works", ...agent });
  expect(replaced.state).toBe("retired");
  expect(replaced.checked).toContain("newer");

  const wrong = agentRetire(index(dir), dir, { target: other.id, reason: "wrong", evidence: "I think it works", ...agent });
  expect(wrong.state).toBe("proposed");
});

test("replaced is refused as proof when the named record is older", async () => {
  const { dir } = await repo("auto");
  const older = kept("An earlier kept record");
  appendRecord(dir, older);
  const r = deadEnd("Pool the redis connections", new Date());
  appendRecord(dir, r);
  const out = agentRetire(index(dir), dir, { target: r.id, reason: "replaced", by: older.id, evidence: "see the other one", ...agent });
  expect(out.state).toBe("proposed");
  expect(out.checked).toContain("older");
});

test("files-gone is checked against HEAD", async () => {
  const { dir } = await repo("auto");
  const r = deadEnd("Pool the redis connections");
  appendRecord(dir, r);
  expect(agentRetire(index(dir), dir, { target: r.id, reason: "files-gone", evidence: "pool.ts was removed", ...agent }).state).toBe("proposed");

  // Decline the proposal, remove the file, and ask again.
  personDecide(index(dir), dir, r.id, "decline");
  await unlink(join(dir, "pool.ts"));
  git(dir, "commit", "-q", "-am", "drop pool");
  const out = agentRetire(index(dir), dir, { target: r.id, reason: "files-gone", evidence: "pool.ts was removed", ...agent });
  expect(out.state).toBe("retired");
});

test("a retired record stays searchable, labelled, and the person can restore it", async () => {
  const { dir } = await repo("auto");
  const r = deadEnd("Pool the redis connections");
  appendRecord(dir, r);
  personDecide(index(dir), dir, r.id, "retire", "works since the upgrade", "wrong");

  let db = index(dir);
  const found = tried(db, "redis").find((h) => h.id === r.id);
  expect(found?.retired).toBe("wrong");

  personDecide(db, dir, r.id, "restore");
  db = index(dir);
  expect(tried(db, "redis").find((h) => h.id === r.id)?.retired).toBeNull();
  expect(openDeadEnds(db).map((h) => h.id)).toContain(r.id);
});

test("a reason is one of the four named, never a name every object has", async () => {
  const { dir } = await repo("auto");
  const r = deadEnd("Pool the redis connections");
  appendRecord(dir, r);
  expect(() => agentRetire(index(dir), dir, { target: r.id, reason: "constructor", evidence: "it works now", ...agent })).toThrow("reason must be one of");
  expect(() => personDecide(index(dir), dir, r.id, "retire", "", "toString")).toThrow("reason must be one of");
  expect(() => validateRecord(rec({ retires: { id: r.id, state: "retired", reason: "constructor" as never, evidence: "x" } }))).toThrow("retires.reason must be one of");
});
