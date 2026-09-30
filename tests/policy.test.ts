/**
 * What a project saves, and who can read each part.
 *
 * The promise to a person is exact: off means not saved anywhere, private
 * means kept on this machine only, shared means it travels. These check each
 * promise against what actually lands in git.
 */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { repoView } from "../server/api";
import { exportPolicy, importPolicy, PRESETS, readPolicy, writePolicy } from "../protocol/policy";
import { appendRecord, readRecord } from "../protocol/record";
import { marker } from "../protocol/localonly";
import { git, gitRepo, rec } from "./helpers";

function repo() {
  return { dir: gitRepo() };
}

const record = () => rec({
  intent: { goal: "Pool the redis connections", why: "ssl context is not copyable" },
  outcome: { status: "abandoned", recheck: "bun test", errors: ["failed: bun test"] },
  delta: { files: ["src/pool.ts"] },
  detail: { output: "ssl.SSLError: no certificate", narrative: "The pool shared one context." },
});

const refs = (dir: string, prefix: string) => git(dir, "for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean);

test("with no choice made, the team preset applies and says it was not chosen", async () => {
  const { dir } = repo();
  const p = readPolicy(dir);
  expect(p.preset).toBe("team");
  expect(p.chosen).toBe(false);
});

test("a raw-log field cannot be shared", async () => {
  const { dir } = repo();
  const p = { preset: "team", ...structuredClone(PRESETS.team!.policy) };
  p.fields.prompts = "shared";
  expect(() => writePolicy(dir, p)).toThrow(/cannot be shared/);
});

test("private fields leave the shared copy and stay in a private companion", async () => {
  const { dir } = repo();
  // Team: full output is private, the reason is shared.
  const r = record();
  appendRecord(dir, r);
  const [shared] = refs(dir, "refs/anvc/");
  const [companion] = refs(dir, "refs/anvc-private/");
  expect(readRecord(dir, shared!).detail?.output).toBeUndefined();
  expect(readRecord(dir, shared!).intent.why).toBe("ssl context is not copyable");
  expect(readRecord(dir, companion!).detail?.output).toBe("ssl.SSLError: no certificate");
  expect(readRecord(dir, companion!).id).toBe(r.id);
  // It reads as shared, because the team has it — with the fuller content.
  const [a] = repoView(dir).turns;
  expect(a!.tier).toBe("shared");
});

test("an off field is saved in neither copy", async () => {
  const { dir } = repo();
  const p = { preset: "team", ...structuredClone(PRESETS.team!.policy) };
  p.fields.narrative = "off";
  p.fields.detail_output = "off";
  writePolicy(dir, p);
  appendRecord(dir, record());
  for (const ref of [...refs(dir, "refs/anvc/"), ...refs(dir, "refs/anvc-private/")]) {
    const stored = readRecord(dir, ref);
    expect(stored.detail?.narrative).toBeUndefined();
    expect(stored.detail?.output).toBeUndefined();
  }
  // Nothing was held back from the shared copy, so no companion was needed.
  expect(refs(dir, "refs/anvc-private/")).toHaveLength(0);
});

test("when every field is shared, one shared record is written and nothing else", async () => {
  const { dir } = repo();
  const p = { preset: "private-repo", ...structuredClone(PRESETS["private-repo"]!.policy) };
  writePolicy(dir, p);
  appendRecord(dir, record());
  expect(refs(dir, "refs/anvc/")).toHaveLength(1);
  expect(refs(dir, "refs/anvc-private/")).toHaveLength(0);
});

test("a policy exports to one line and comes back the same", () => {
  const p = { preset: "team", ...structuredClone(PRESETS.team!.policy) };
  p.fields.steps = "shared";
  p.retire = "auto";
  const line = exportPolicy(p);
  expect(line).toBe("team+steps=shared;retire=auto");
  expect(importPolicy(line)).toEqual(p);
});

test("a policy takes only the presets, fields, modes and tiers it names", () => {
  const { dir } = repo();
  const team = { preset: "team", ...structuredClone(PRESETS.team!.policy) };
  expect(() => writePolicy(dir, { ...team, tier: "everyone" as never })).toThrow("tier must be private or shared");
  expect(() => writePolicy(dir, { ...team, preset: "constructor" })).toThrow("unknown preset");
  expect(() => writePolicy(dir, { ...team, fields: { ...team.fields, constructor: "off" } as never })).toThrow("unknown field constructor");
  expect(() => importPolicy("constructor")).toThrow("unknown preset");
  expect(() => importPolicy("team+toString=off")).toThrow("unknown field toString");
  expect(() => writePolicy(dir, importPolicy("team;tier=everyone"))).toThrow("tier must be");

  // A file that already holds one reads as the preset's value.
  const file = marker(dir, "policy.json")!;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ preset: "toString", fields: {}, retire: "sometimes", tier: "everyone" }));
  expect(readPolicy(dir)).toMatchObject({ preset: "team", retire: "ask", tier: "shared" });
});
