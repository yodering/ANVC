/**
 * Goals and writing rules kept up to date from the sessions (protocol/absorb.ts).
 *
 * The model is a stand-in that answers with a fixed plan, so these test what
 * ANVC does with an answer: what it reads, what it writes, and when it runs.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { absorb, absorbDue, brief, material, parsePlan, readCursor, setAbsorbMode, type Runner } from "../protocol/absorb";
import { readActivity } from "../protocol/activity";
import { allGoals, changeGoal, goalTree } from "../protocol/goals";
import { appendRecord } from "../protocol/record";
import { listRules, removeRule } from "../protocol/rules";
import { partMaps, withIndex } from "../protocol/query";
import { gitRepo, rec, runHook, tmp, writeCapture } from "./helpers";

const answering = (plan: object, seen: string[] = []): Runner => (_system, input) => {
  seen.push(input);
  return { text: "```json\n" + JSON.stringify(plan) + "\n```", tokens: 4_000 };
};

function project() {
  const repo = gitRepo({ commit: true });
  const capture = tmp("anvc-absorb-capture-");
  writeCapture(repo, [
    { session_id: "s1", event: "UserPromptSubmit", prompt: "We need to find out whether a 21x21 coloring exists. Keep replies very short." },
    { session_id: "s1", event: "UserPromptSubmit", prompt: "Try to break the 44-cell skeleton next." },
  ], capture);
  appendRecord(repo, rec({ session: { agent: "claude-code", run_id: "s1" }, intent: { goal: "Fix the skeleton cells and solve the core", why: "UNSAT in 40 s" } }));
  return { repo, capture };
}

const PLAN = {
  goals: [
    { id: "decide", title: "Decide whether a 21x21 coloring exists", status: "doing", why: "The person asked for it." },
    { id: "skeleton", title: "Break the 44-cell skeleton", parent: "decide", status: "doing", why: "Asked next." },
  ],
  rules: [{ name: "Replies to me", applies: ["replies"], text: "Keep replies very short." }],
};

test("it's off until the person turns it on, and then runs only when something is new and half an hour has passed", () => {
  const { repo, capture } = project();
  expect(absorbDue(repo, Date.now(), capture)).toBe(false);
  expect(absorb(repo, { runner: answering(PLAN), captureRoot: capture })).toBeNull();
  setAbsorbMode(repo, "claude");
  expect(absorbDue(repo, Date.now(), capture)).toBe(true);
  absorb(repo, { runner: answering(PLAN), captureRoot: capture });
  // Nothing new since, and not half an hour later either.
  expect(absorbDue(repo, Date.now() + 60 * 60_000, capture)).toBe(false);
  writeCapture(repo, [{ session_id: "s2", event: "UserPromptSubmit", prompt: "The skeleton is rigid, stop that line." }], capture);
  expect(absorbDue(repo, Date.now(), capture)).toBe(false);
  expect(absorbDue(repo, Date.now() + 31 * 60_000, capture)).toBe(true);
});

test("an update adds goals under the goal they belong to, a private rule set, and moves on from what it read", () => {
  const { repo, capture } = project();
  setAbsorbMode(repo, "claude");
  const inputs: string[] = [];
  const done = absorb(repo, { runner: answering(PLAN, inputs), captureRoot: capture })!;
  expect(done).toEqual({ written: 3, tokens: 4_000 });

  // It read the person's prompts and the recorded attempt, and the goals as they were.
  expect(inputs[0]).toContain("Try to break the 44-cell skeleton next.");
  expect(inputs[0]).toContain("- kept: Fix the skeleton cells and solve the core — UNSAT in 40 s");
  expect(inputs[0]).toContain("Goals now:\n(none yet)");

  const [top] = goalTree(repo);
  expect(top!.title).toBe("Decide whether a 21x21 coloring exists");
  expect(top!.status).toBe("doing");
  expect(top!.subgoals.map((g) => g.title)).toEqual(["Break the 44-cell skeleton"]);
  // Filed as ANVC's, under the session it came from.
  expect(top!.versions[0]).toMatchObject({ agent: "anvc", session: "s1", by: "agent" });
  const [rule] = listRules(repo);
  expect(rule).toMatchObject({ name: "Replies to me", applies: ["replies"], text: "Keep replies very short.", tier: "private" });

  expect(readCursor(repo)).toMatchObject({ runs: 1, tokens: 4_000 });
  const [row] = readActivity({ repo, kinds: ["absorbed"] });
  expect(row).toMatchObject({ kind: "absorbed", via: "claude", tokens: 4_000 });
  expect(row!.titles).toContain("Break the 44-cell skeleton");

  // The next update reads only what's new, and changes a goal rather than adding it twice.
  writeCapture(repo, [{ session_id: "s2", event: "UserPromptSubmit", prompt: "The skeleton is rigid. Drop that line." }], capture);
  const skeleton = top!.subgoals[0]!.id;
  absorb(repo, {
    runner: answering({ goals: [{ id: skeleton, title: "Break the 44-cell skeleton", status: "dropped", why: "The person dropped it." }, { title: "Decide whether a 21x21 coloring exists", status: "doing" }], rules: [] }, inputs),
    captureRoot: capture, now: Date.now() + 31 * 60_000,
  });
  expect(inputs[1]).toContain("The skeleton is rigid. Drop that line.");
  expect(inputs[1]).not.toContain("Try to break the 44-cell skeleton next.");
  expect(inputs[1]).toContain(`id ${skeleton} [doing] Break the 44-cell skeleton`);
  const goals = allGoals(goalTree(repo));
  expect(goals).toHaveLength(2);
  expect(goals.find((g) => g.id === skeleton)!.status).toBe("dropped");
});

test("an answer that isn't the plan's shape writes nothing, and a sub-goal under a goal nobody named is left out", () => {
  expect(parsePlan("no JSON here")).toEqual({ goals: [], rules: [], map: [] });
  expect(parsePlan('{"goals": [{"title": "x", "status": "maybe"}], "rules": [{"name": "y"}]}')).toEqual({ goals: [], rules: [], map: [] });
  const { repo, capture } = project();
  setAbsorbMode(repo, "claude");
  absorb(repo, { runner: answering({ goals: [{ title: "Orphan", parent: "nowhere", status: "todo" }], rules: [] }), captureRoot: capture });
  expect(goalTree(repo)).toEqual([]);
});

test("a long session's prompts are cut, and the newest are kept when there are too many", () => {
  const { repo, capture } = project();
  writeCapture(repo, Array.from({ length: 80 }, (_, i) => ({ session_id: "s1", event: "UserPromptSubmit", prompt: `Prompt ${i} ${"x".repeat(1_000)}` })), capture);
  const m = material(repo, "", capture);
  expect(m.prompts.every((p) => p.text.length <= 600)).toBe(true);
  expect(m.prompts.at(-1)!.text).toStartWith("Prompt 79");
  expect(m.prompts.length).toBeLessThan(80);
  expect(brief("p", [], [], m).length).toBeLessThan(18_000);
});

// Skipped on Windows: the stand-in for claude is a sh script.
test.skipIf(process.platform === "win32")("a turn's end starts the update in the background, through claude", async () => {
  const { repo, capture } = project();
  setAbsorbMode(repo, "claude");
  const bin = tmp("anvc-absorb-bin-");
  const answer = JSON.stringify([{ type: "result", result: JSON.stringify(PLAN), total_cost_usd: 0.002, usage: { input_tokens: 3_000, output_tokens: 200 } }]);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${answer.replaceAll("'", "'\\''")}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  runHook("stop", "Stop", { hook_event_name: "Stop", session_id: "s1", cwd: repo, stop_hook_active: false }, { ANVC_CAPTURE_DIR: capture, PATH: `${bin}:${process.env.PATH}` });
  // The cursor is written last, after the goals, so it's what to wait for.
  for (let i = 0; i < 150 && !readCursor(repo); i++) await Bun.sleep(100);
  expect(goalTree(repo)[0]?.title).toBe("Decide whether a 21x21 coloring exists");
  expect(readCursor(repo)).toMatchObject({ runs: 1, tokens: 3_200 });
  expect(existsSync(join(repo, ".git", "anvc", "absorbing"))).toBe(false);
}, 30_000);

test("what the person changed or dropped stands: an update doesn't change it, add it back, or bring back a rule set they removed", () => {
  const { repo, capture } = project();
  setAbsorbMode(repo, "claude");
  absorb(repo, { runner: answering(PLAN), captureRoot: capture });
  const [top] = goalTree(repo);
  const skeleton = top!.subgoals[0]!;
  const person = { kind: "person" as const };
  changeGoal(repo, skeleton.id, { status: "dropped", why: "Not this line." }, person);
  changeGoal(repo, top!.id, { status: "done", why: "Decided." }, person);
  removeRule(repo, listRules(repo)[0]!.id, person, "I don't want this one.");

  writeCapture(repo, [{ session_id: "s2", event: "UserPromptSubmit", prompt: "Keep going on the skeleton." }], capture);
  const inputs: string[] = [];
  absorb(repo, { runner: answering(PLAN, inputs), captureRoot: capture, now: Date.now() + 31 * 60_000 });
  // The model is told, and its answer doesn't override the person either way.
  expect(inputs[0]).toContain("Dropped, so never add these again:\n- Break the 44-cell skeleton");
  const goals = allGoals(goalTree(repo));
  expect(goals).toHaveLength(2);
  expect(goals.find((g) => g.id === skeleton.id)!.status).toBe("dropped");
  expect(goals.find((g) => g.id === top!.id)!.status).toBe("done");
  expect(listRules(repo)).toEqual([]);
});

test("a goal listed after its sub-goals, or naming itself as its parent, still gets its sub-goals under it", () => {
  const { repo, capture } = project();
  setAbsorbMode(repo, "codex");
  absorb(repo, {
    runner: answering({ goals: [
      { id: "b", title: "Sub-goal first in the list", parent: "a", status: "todo" },
      { id: "a", title: "The goal", parent: "a", status: "doing" },
    ], rules: [] }),
    captureRoot: capture,
  });
  const [top] = goalTree(repo);
  expect(top!.title).toBe("The goal");
  expect(top!.subgoals.map((g) => g.title)).toEqual(["Sub-goal first in the list"]);
});

test("an update maps the project's parts, keeps only folders that exist, and leaves a part the person wrote", () => {
  const { repo, capture } = project();
  for (const f of ["cloud/runner.py", "cloud/lanes.py", "docs/plan.md"]) {
    Bun.spawnSync(["mkdir", "-p", join(repo, f.split("/")[0]!)]);
    writeFileSync(join(repo, f), "x\n");
  }
  Bun.spawnSync(["git", "add", "."], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "files"], { cwd: repo });
  setAbsorbMode(repo, "claude");
  const inputs: string[] = [];
  absorb(repo, {
    runner: answering({ goals: [], rules: [], map: [
      { part: "the cloud runner", does: "Runs the search lanes on rented machines.", layer: "edge", owns: ["cloud/", "nowhere/"] },
      { part: "invented", does: "A part with no real folder.", owns: ["made-up/"] },
    ] }, inputs),
    captureRoot: capture,
  });
  expect(inputs[0]).toContain("- cloud/ (2 files: lanes.py, runner.py)");
  const parts = withIndex(repo, (db) => partMaps(db));
  expect(parts.map((p) => [p.part, p.owns])).toEqual([["the cloud runner", ["cloud/"]]]);
  expect(parts[0]!.layer).toBe("edge");
});
