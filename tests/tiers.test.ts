/**
 * Private and shared, held apart by git rather than by us.
 *
 * The claim this file exists to check is the one a user cannot check for
 * themselves: that a private record does not leave the machine. It is tested
 * the only way that means anything — by pushing to a real remote and listing
 * what arrived — because the bug this replaces passed every test that counted
 * refs locally while nineteen scraped records sat on GitHub.
 */
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { ingest, type CaptureEvent } from "../protocol/ingest";
import { configureRemote, readRefs } from "../protocol/git";
import { buildIndex, openIndex, summary, tried } from "../protocol/query";
import { repoView } from "../server/api";
import {
  appendRecord, defaultTier, findRecordRef, listRecords, moveRecord, portable, readRecord, ulid,
  type CheckpointRecord,
} from "../protocol/record";
import { tierFacts } from "../protocol/tiers";
import { cli, git, gitRepo, rec } from "./helpers";

function repo(): { dir: string; remote: string } {
  const dir = gitRepo({ commit: true });
  const remote = gitRepo({ bare: true });
  git(dir, "remote", "add", "origin", remote);
  return { dir, remote };
}

const record = (goal: string, over: Partial<CheckpointRecord> = {}) => rec({ intent: { goal }, ...over });

test("a private record is not sent by git push; a shared one is", async () => {
  const { dir, remote } = repo();
  configureRemote(dir, "origin");
  appendRecord(dir, record("share this"));
  appendRecord(dir, record("keep this here"), { tier: "private" });
  const pushed = Bun.spawnSync(["git", "-C", dir, "push", "-q", "origin"], { stdout: "pipe", stderr: "pipe" });
  expect(pushed.exitCode).toBe(0);

  const arrived = git(remote, "for-each-ref", "--format=%(refname)");
  expect(arrived).toContain("refs/anvc/s/000001");
  expect(arrived).not.toContain("anvc-private");
  // And the content, not just the name: nothing on the remote says it.
  const blobs = git(remote, "for-each-ref", "--format=%(objectname)", "refs/anvc/").split("\n");
  const text = blobs.map((oid) => git(remote, "cat-file", "-p", oid)).join("\n");
  expect(text).toContain("share this");
  expect(text).not.toContain("keep this here");
});

test("both tiers are read here: private means unshared, not hidden", async () => {
  const { dir } = repo();
  appendRecord(dir, record("shared cache attempt"));
  appendRecord(dir, record("private cache attempt"), { tier: "private" });
  expect(listRecords(dir)).toHaveLength(2);
  const db = openIndex();
  buildIndex(db, dir);
  try {
    const hits = tried(db, "cache");
    expect(hits.map((h) => h.tier).sort()).toEqual(["private", "shared"]);
    expect(summary(db).tiers).toEqual({ private: 1, shared: 1 });
    expect(repoView(dir).turns.map((a) => a.tier).sort()).toEqual(["private", "shared"]);
  } finally { db.close(); }
});

test("a shared record carries no absolute path and no prompt; a private one keeps both", async () => {
  const { dir } = repo();
  const home = homedir();
  const body = record("fix the pool", {
    intent: { goal: "fix the pool", prompt: "ugh fix the pool again" },
    actions: [
      { kind: "write", path: `${dir}/src/pool.ts`, ts: new Date().toISOString() },
      { kind: "shell", command: `cat ${home}/notes/pool.md`, ts: new Date().toISOString() },
    ],
  });
  const shared = portable(body, dir);
  expect(shared.actions![0]!.path).toBe("src/pool.ts");
  expect(shared.actions![1]!.command).toBe("cat ~/notes/pool.md");
  // What a person typed stays on the machine even when the record travels.
  expect(shared.intent.prompt).toBeUndefined();
  expect(shared.intent.goal).toBe("fix the pool");

  const kept = appendRecord(dir, body, { tier: "private" });
  const stored = readRecord(dir, kept.ref);
  expect(stored.intent.prompt).toBe("ugh fix the pool again");
  expect(stored.actions![0]!.path).toBe(`${dir}/src/pool.ts`);

  // Written to the shared tier, the stored blob is already the portable form.
  const out = appendRecord(dir, { ...body, id: ulid() });
  expect(readRecord(dir, out.ref).intent.prompt).toBeUndefined();
});

test("on Windows, every spelling of the repository and home folder leaves a shared record", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const body = rec({ intent: { goal: "fix the pool" }, actions: [
      { kind: "write", path: "c:\\users\\SAM\\shop\\src\\pool.ts", ts: "2026-09-30T10:00:00.000Z" },
      { kind: "shell", command: 'bun "C:\\\\Users\\\\sam\\\\shop\\\\x.ts"; cat /c/Users/sam/notes.md', ts: "2026-09-30T10:00:01.000Z" },
    ] });
    const shared = portable(body, "C:\\Users\\sam\\shop", "C:\\Users\\sam");
    expect(shared.actions![0]!.path).toBe("src\\pool.ts");
    expect(shared.actions![1]!.command).toBe('bun "x.ts"; cat ~/notes.md');
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("scraped records are private unless someone decides otherwise", async () => {
  const { dir } = repo();
  const base = { anvc_capture: 0 as const, session_id: "s1", cwd: dir, repo: dir, bytes: null, path: null, prompt: null, ok: null, command: null, tool: null };
  const events: CaptureEvent[] = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-01T10:00:00.000Z", prompt: "run the tests" },
    { ...base, event: "PostToolUse", ts: "2026-09-01T10:00:05.000Z", tool: "Bash", command: "bun test", ok: false, output: "1 fail" },
  ];
  expect(ingest(dir, events).written).toBe(1);
  const refs = listRecords(dir).map((r) => r.ref);
  // This is the default that would have kept nineteen scraped records off GitHub.
  expect(refs).toHaveLength(1);
  expect(refs[0]!.startsWith("refs/anvc-private/")).toBe(true);
});

test("sharing moves a record and keeps its id; unsharing moves it back", async () => {
  const { dir } = repo();
  const body = record("an attempt worth sharing");
  const { ref } = appendRecord(dir, body, { tier: "private" });
  expect(findRecordRef(dir, body.id)).toBe(ref);

  const shared = moveRecord(dir, ref, "shared");
  expect(shared.ref.startsWith("refs/anvc/")).toBe(true);
  expect(readRecord(dir, shared.ref).id).toBe(body.id);
  // The private copy is gone rather than left behind as a duplicate.
  expect(listRecords(dir).map((r) => r.ref)).toEqual([shared.ref]);
  expect(shared.pushed).toBe(false);

  const back = moveRecord(dir, shared.ref, "private");
  expect(back.ref.startsWith("refs/anvc-private/")).toBe(true);
  expect(() => moveRecord(dir, back.ref, "private")).toThrow(/already private/);
});

test("sharing a record leaves out what the policy keeps private, also after unsharing it", async () => {
  const { dir } = repo();
  // The team preset keeps steps and full output on this machine.
  const body = record("run the migration", {
    actions: [{ kind: "shell", command: "bun run migrate", ts: new Date().toISOString() }],
    detail: { output: "relation users does not exist" },
  });
  const { ref } = appendRecord(dir, body, { tier: "private" });
  // Every ref, not listRecords, which shows one ref per object.
  const copies = (prefix: string) => readRefs(dir, prefix).map((r) => readRecord(dir, r.ref));

  const check = () => {
    const [shared, ...more] = copies("refs/anvc/");
    expect(more).toEqual([]);
    expect(shared!.id).toBe(body.id);
    expect(shared!.actions).toBeUndefined();
    expect(shared!.detail).toBeUndefined();
    // The whole record stays here, once, as a shared write keeps it.
    const kept = copies("refs/anvc-private/");
    expect(kept.map((r) => [r.id, r.actions?.length, r.detail?.output])).toEqual([[body.id, 1, "relation users does not exist"]]);
  };
  moveRecord(dir, ref, "shared");
  check();
  expect(cli(dir, "unshare", body.id).code).toBe(0);
  expect(cli(dir, "share", body.id).code).toBe(0);
  check();
});

test("unsharing a record that was already pushed says the remote still has it", async () => {
  const { dir } = repo();
  configureRemote(dir, "origin");
  const { ref } = appendRecord(dir, record("already out there"));
  git(dir, "push", "-q", "origin");
  git(dir, "fetch", "-q", "origin");
  // A local move cannot take back a remote's copy, and must not sound like it did.
  expect(moveRecord(dir, ref, "private").pushed).toBe(true);
});

test("a repository can default to private", async () => {
  const { dir } = repo();
  expect(defaultTier(dir)).toBe("shared");
  git(dir, "config", "anvc.tier", "private");
  expect(defaultTier(dir)).toBe("private");
});

test("tier facts count what is pushed and what is waiting", async () => {
  const { dir } = repo();
  configureRemote(dir, "origin");
  appendRecord(dir, record("first"));
  git(dir, "push", "-q", "origin");
  git(dir, "fetch", "-q", "origin");
  appendRecord(dir, record("second"));
  appendRecord(dir, record("third"), { tier: "private" });
  const f = tierFacts(dir);
  expect(f.pushConfigured).toBe(true);
  expect(f.shared).toMatchObject({ records: 2, pushed: 1, waiting: 1 });
  expect(f.private.records).toBe(1);
});

test("a record written before today's rules still moves", async () => {
  const { dir } = repo();
  // No goal and no evidence: valid when it was written, refused by the rules
  // for new records now. Five of this repository's scraped records were this
  // shape and stayed shared, because moving re-ran those rules.
  const legacy = record("x", { intent: { prompt: "an old captured turn" } });
  const blob = Bun.spawnSync(["git", "-C", dir, "hash-object", "-w", "--stdin"],
    { stdin: Buffer.from(JSON.stringify(legacy)), stdout: "pipe" }).stdout.toString().trim();
  git(dir, "update-ref", "refs/anvc/s/000001", blob);
  const moved = moveRecord(dir, "refs/anvc/s/000001", "private");
  expect(moved.ref).toBe("refs/anvc-private/s/000001");
  // Placed, not re-written: the same object, byte for byte.
  expect(moved.oid).toBe(blob);
});
