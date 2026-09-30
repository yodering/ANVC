/**
 * A record fills the evidence the agent left out, from the session's raw log.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readRecords } from "../protocol/record";
import { gitRepo, tmp, tool, writeCapture } from "./helpers";

function setup() {
  const repo = gitRepo();
  const state = tmp("anvc-evidence-state-");
  const capture = join(state, "capture");
  const rows = (list: object[]) => writeCapture(repo, list.map((r) => ({ session_id: "sess-e", ...r })), capture);
  const checkpoint = (args: object) =>
    tool(repo, "anvc_checkpoint", args, { ANVC_SESSION: "sess-e", ANVC_CAPTURE_DIR: capture, ANVC_STATE_DIR: state });
  // The fullest copy of a record: the private companion when the policy held fields back.
  const stored = () => readRecords(repo).at(-1)![1];
  return { repo, rows, checkpoint, stored };
}

test("an abandoned record gets its commands, its failure and the files it touched", async () => {
  const { repo, rows, checkpoint, stored } = setup();
  rows([
    { tool: "Edit", path: join(repo, "src/pool.ts") },
    { tool: "Bash", command: "bun test", ok: false, output: "running\n1 fail: ssl context not copyable" },
  ]);
  const reply = checkpoint({ goal: "Pool the redis connections", outcome: "abandoned", why: "ssl context", recheck: "bun test" });
  expect(reply).toContain("attached from this session's log: 1 command, the output of `bun test`, 1 file changed");
  const r = stored();
  expect(r.detail?.commands).toEqual(["bun test"]);
  expect(r.detail?.output).toContain("1 fail: ssl context not copyable");
  expect(r.outcome.errors).toEqual(["bun test: 1 fail: ssl context not copyable"]);
  expect(r.delta?.files).toEqual(["src/pool.ts"]);
});

test("a kept record gets its commands and files, and no failure from along the way", async () => {
  const { repo, rows, checkpoint, stored } = setup();
  rows([
    { tool: "Bash", command: "bun test", ok: false, output: "1 fail" },
    { tool: "Edit", path: join(repo, "src/pool.ts") },
    { tool: "Bash", command: "bun test", ok: true },
  ]);
  checkpoint({ goal: "Pool the redis connections", outcome: "kept" });
  const r = stored();
  expect(r.detail?.commands).toEqual(["bun test", "bun test"]);
  expect(r.detail?.output).toBeUndefined();
  expect(r.outcome.errors).toBeUndefined();
  expect(r.delta?.files).toEqual(["src/pool.ts"]);
});

test("what the agent wrote is never replaced", async () => {
  const { repo, rows, checkpoint, stored } = setup();
  rows([{ tool: "Bash", command: "bun test", ok: false, output: "1 fail" }, { tool: "Edit", path: join(repo, "a.ts") }]);
  checkpoint({
    goal: "Pool the redis connections", outcome: "abandoned", recheck: null, files: ["b.ts"],
    detail: { output: "the agent's own excerpt", commands: ["bun test tests/pool.test.ts"] },
  });
  const r = stored();
  expect(r.detail?.output).toBe("the agent's own excerpt");
  expect(r.detail?.commands).toEqual(["bun test tests/pool.test.ts"]);
  expect(r.delta?.files).toEqual(["b.ts"]);
});

test("a dead end with no check gets the last failing test as one, and never another command", async () => {
  const { fillEvidence } = await import("../protocol/evidence");
  const record = () => ({
    anvc: 0, id: "01M3JE4EEAYFY1S0PR9387H396", anchor: { kind: "blob", oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "s" }, intent: { goal: "Try the cache" },
    outcome: { status: "abandoned", recheck: null }, ts: new Date().toISOString(),
  }) as any;
  const row = (command: string, ok: boolean) => ({ anvc_capture: 0, tool: "Bash", command, ok, ts: new Date().toISOString() }) as any;

  const withTest = record();
  const filled = fillEvidence(withTest, [row("bun test tests/cache.test.ts", false), row("curl https://example.com", false)], "/r");
  expect(withTest.outcome.recheck).toBe("bun test tests/cache.test.ts");
  expect(filled.recheck).toBe("bun test tests/cache.test.ts");

  const withoutTest = record();
  fillEvidence(withoutTest, [row("curl https://example.com", false), row("bun test", true)], "/r");
  expect(withoutTest.outcome.recheck).toBeNull();
});

test("a long session's evidence is shortened to fit the record, and what the agent wrote is not", async () => {
  const { fillEvidence } = await import("../protocol/evidence");
  const { validateForWrite } = await import("../protocol/record");
  const narrative = "what I saw ".repeat(2000);
  const record = (detail = {}) => ({
    anvc: 0, id: "01M3JE4EEAYFY1S0PR9387H396", anchor: { kind: "blob", oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "s" }, intent: { goal: "Try the cache", why: "w".repeat(2000) },
    outcome: { status: "abandoned", recheck: null }, detail, ts: new Date().toISOString(),
  }) as any;
  const ts = new Date().toISOString();
  const failing = (output: string) => ({ anvc_capture: 0, tool: "Bash", command: "bun test", ok: false, output, ts });

  // 40 long commands, 500 deep paths and 16 KiB of output don't fit in 64 KiB beside the agent's own 24 KiB.
  const long = record({ narrative });
  const filled = fillEvidence(long, [
    ...Array.from({ length: 40 }, (_, i) => ({ anvc_capture: 0, tool: "Bash", command: `printf '${"x".repeat(2000)}' > f${i}`, ok: true, ts })),
    ...Array.from({ length: 500 }, (_, i) => ({ anvc_capture: 0, tool: "Edit", path: `/r/src/${"deep/".repeat(12)}file-${i}.ts`, ts })),
    failing(`${"running\n".repeat(2000)}1 fail: cache miss`),
  ] as any[], "/r");
  expect(() => validateForWrite(long)).not.toThrow();
  expect(long.detail.narrative).toBe(narrative);
  expect(long.intent.why).toBe("w".repeat(2000));
  expect(long.truncated).toBe(true);
  expect(long.delta.files.length).toBeGreaterThan(0);
  expect(filled.files).toBe(long.delta.files.length);

  // Two bytes a character: 16K of them is over the byte caps on the output and the error line.
  const wide = record();
  fillEvidence(wide, [failing("é".repeat(16_000))] as any[], "/r");
  expect(() => validateForWrite(wide)).not.toThrow();
  expect(wide.detail.output).toStartWith("$ bun test\n");
});
