/**
 * A result keeps its standing: where it lives, whether it was checked, what it
 * depends on, and a status only the person can lock.
 */
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkResult, describe, fingerprint, listResults, readValue, recordResult, recordStatus, sameNumber, whence } from "../protocol/results";
import { captureFile } from "../protocol/rawlog";
import { appendRecord } from "../protocol/record";
import { git, gitRepo, rec, runHook, setEnv, tmp, tool, writeCapture } from "./helpers";

const agent = { kind: "agent" as const, agent: "claude-code", session: "s1" };
const person = { kind: "person" as const };

function project() {
  const repo = gitRepo();
  mkdirSync(join(repo, "results"), { recursive: true });
  mkdirSync(join(repo, "a"));
  mkdirSync(join(repo, "d"));
  writeFileSync(join(repo, "results", "v6.json"), JSON.stringify({ test: { acc: 0.8812 } }));
  writeFileSync(join(repo, "results", "table.csv"), "run,acc,f1\nv4,0.861,0.80\nv6,0.8812,0.83\n");
  writeFileSync(join(repo, "a", "model.py"), "A = 1\n");
  writeFileSync(join(repo, "d", "model.py"), "D = 1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return { repo };
}

test("a written number matches the value it was rounded from", () => {
  expect(sameNumber("88.1%", "0.8812")).toBe(true);
  expect(sameNumber("0.881", "0.8812")).toBe(true);
  expect(sameNumber("88.12", "0.8812")).toBe(true);
  expect(sameNumber("88.2%", "0.8812")).toBe(false);
  expect(sameNumber("1,234", "1234")).toBe(true);
  // One significant digit is too few to read as a percent too.
  expect(sameNumber("0.02", "0.022")).toBe(true);
  expect(sameNumber("0.02", "2%")).toBe(false);
  expect(sameNumber("0.02", "0.00022")).toBe(false);
  expect(sameNumber("0.80", "80%")).toBe(true);
  expect(sameNumber("5%", "0.05")).toBe(true);
  expect(sameNumber("1e-4", "0.0001")).toBe(true);
  expect(sameNumber("3.2e-5", "0.000032")).toBe(true);
  expect(sameNumber("\u22120.5", "-0.5")).toBe(true);
  // A share written from a printed count, unless it's too round to tell.
  expect(sameNumber("76%", "38/50")).toBe(true);
  expect(sameNumber("50%", "5/10")).toBe(false);
});

test("a value is read from JSON, CSV or a log line", async () => {
  const p = project();
  expect(readValue(join(p.repo, "results", "v6.json"), "test.acc")).toBe("0.8812");
  expect(readValue(join(p.repo, "results", "table.csv"), "v4/f1")).toBe("0.80");
  writeFileSync(join(p.repo, "results", "log.txt"), "epoch 9\nval accuracy: 0.8812 (best)\n");
  expect(readValue(join(p.repo, "results", "log.txt"), "val accuracy")).toBe("0.8812");
  expect(fingerprint(join(p.repo, "nope"))).toBeNull();
  expect(fingerprint(join(p.repo, "results"))?.hash).toMatch(/^folder:/);
});

test("a quoted CSV field keeps its commas, quotes and line breaks in one cell", async () => {
  const p = project();
  const csv = join(p.repo, "results", "quoted.csv");
  writeFileSync(csv, 'run,note,acc\r\n"Results, final","said ""best""",0.8823\r\n"two\nlines",,0.5\r\nv7,"",0.9\r\n');
  expect(readValue(csv, "Results, final/acc")).toBe("0.8823");
  expect(readValue(csv, "Results, final/note")).toBe('said "best"');
  expect(readValue(csv, "two\nlines/acc")).toBe("0.5");
  expect(readValue(csv, "v7/acc")).toBe("0.9");
  // whence reads the file the same way, so the key it gives finds the value.
  expect(whence(p.repo, "0.8823").elsewhere).toMatchObject([{ path: "results/quoted.csv", key: "Results, final/acc", found: "0.8823" }]);
});

test("a CSV key reads back when its row or its column has a slash in it", async () => {
  const p = project();
  const csv = join(p.repo, "results", "runs.csv");
  // A row named by its checkpoint's path, and columns named as a logger names them.
  writeFileSync(csv, "ckpt,val/acc,loss\nruns/v6/best.pt,0.8814,0.21\nruns/v7/best.pt,0.8731,0.25\n");
  expect(readValue(csv, "runs/v6/best.pt/loss")).toBe("0.21");
  expect(readValue(csv, "runs/v7/best.pt/val/acc")).toBe("0.8731");
  expect(readValue(csv, "runs/v8/best.pt/loss")).toBeNull();
  const [hit] = whence(p.repo, "0.8814").elsewhere;
  expect(hit).toMatchObject({ path: "results/runs.csv", key: "runs/v6/best.pt/val/acc" });
  expect(readValue(csv, hit!.key)).toBe("0.8814");
});

test("recording checks the value at its source, and a lock is the person's call", async () => {
  const p = project();
  const good = recordResult(p.repo, { name: "D accuracy", value: "88.1%", part: "D", source: { path: "results/v6.json", key: "test.acc" }, depends: ["d/model.py"], status: "locked" }, agent);
  expect(good.notes.join(" ")).toContain("Checked: results/v6.json → test.acc holds 0.8812");
  expect(good.notes.join(" ")).toContain("Locking is the person's call");
  let [view] = listResults(p.repo);
  expect(view).toMatchObject({ status: "current", proposed: { status: "locked" } });

  recordStatus(p.repo, good.id, "locked", "Table 2 of the paper", person);
  [view] = listResults(p.repo);
  expect(view).toMatchObject({ status: "locked", by: "person", proposed: null, why: "Table 2 of the paper" });

  // An agent can't undo a lock; it waits for the person.
  recordStatus(p.repo, good.id, "invalid", "looks off", agent);
  [view] = listResults(p.repo);
  expect(view).toMatchObject({ status: "locked", proposed: { status: "invalid" } });

  const wrong = recordResult(p.repo, { name: "D f1", value: "0.9", source: { path: "results/table.csv", key: "v6/f1" } }, agent);
  expect(wrong.notes.join(" ")).toContain("holds 0.83, not 0.9");
});

test("only what a result depends on can make it stale", async () => {
  const p = project();
  const { id } = recordResult(p.repo, { name: "D accuracy", value: "88.1%", part: "D", source: { path: "results/v6.json", key: "test.acc" }, depends: ["d/model.py"] }, agent);
  recordStatus(p.repo, id, "locked", "final", person);
  // Parts A, B and C move on; D's result doesn't care.
  writeFileSync(join(p.repo, "a", "model.py"), "A = 2\n");
  let view = listResults(p.repo).find((r) => r.id === id)!;
  let check = checkResult(p.repo, view);
  expect(check.stale).toBe(false);
  expect(describe(view, check)).toContain("Locked and nothing it depends on changed. Don't re-run it.");
  // D's own code changes: now it is worth asking.
  writeFileSync(join(p.repo, "d", "model.py"), "D = 2\n");
  view = listResults(p.repo).find((r) => r.id === id)!;
  check = checkResult(p.repo, view);
  expect(check.stale).toBe(true);
  expect(describe(view, check)).toContain("d/model.py CHANGED");
  expect(describe(view, check)).toContain("Ask the person before re-running");
  // The file it was read from is overwritten with a new number.
  writeFileSync(join(p.repo, "results", "v6.json"), JSON.stringify({ test: { acc: 0.87 } }));
  expect(describe(view, checkResult(p.repo, view))).toContain("changed since, now holds 0.87");
});

test("a newer result supersedes the one it replaces, unless that one is locked", async () => {
  const p = project();
  const v4 = recordResult(p.repo, { name: "accuracy", value: "86.1%", source: { path: "results/table.csv", key: "v4/acc" } }, agent);
  const v6 = recordResult(p.repo, { name: "accuracy", value: "88.1%", replaces: v4.id, why: "v4 overfit", settings: { lr: "1e-4" } }, agent);
  let all = listResults(p.repo);
  expect(all.find((r) => r.id === v4.id)).toMatchObject({ status: "superseded", replaced_by: v6.id });
  // An agent reading the newer one learns what it replaced and what changed.
  const newer = all.find((r) => r.id === v6.id)!;
  expect(describe(newer, checkResult(p.repo, newer, all), all)).toContain("replaces 86.1%");
  expect(describe(newer, checkResult(p.repo, newer, all), all)).toContain("(lr=1e-4)");

  const w1 = recordResult(p.repo, { name: "f1", value: "0.80" }, agent);
  recordStatus(p.repo, w1.id, "locked", "in the paper", person);
  recordResult(p.repo, { name: "f1", value: "0.83", replaces: w1.id }, agent);
  all = listResults(p.repo);
  expect(all.find((r) => r.id === w1.id)?.status).toBe("locked");
});

test("whence finds a number in the results and in what commands printed", async () => {
  const p = project();
  setEnv({ ANVC_CAPTURE_DIR: tmp("anvc-results-log-") });
  recordResult(p.repo, { name: "D accuracy", value: "0.8812", source: { path: "results/v6.json", key: "test.acc" } }, agent);
  writeCapture(p.repo, [{ session_id: "s0", tool: "Bash", command: "python eval.py --ckpt v6", output: "loading\\nval accuracy 0.8812\\n" }]);
  const found = whence(p.repo, "88.1%");
  expect(found.results.map((r) => r.name)).toEqual(["D accuracy"]);
  expect(found.outputs[0]).toMatchObject({ command: "python eval.py --ckpt v6" });
  expect(whence(p.repo, "D accuracy").results).toHaveLength(1);
});

test("an agent records a result and finds it again by its number, through the MCP server", async () => {
  const p = project();
  const call = (name: string, args: object) => tool(p.repo, name, args, { ANVC_SESSION: "s-mcp" });
  const saved = call("anvc_result", { name: "D accuracy", value: "88.1%", part: "D", source: { path: "results/v6.json", key: "test.acc" }, depends: ["d/model.py"], why: "best of three seeds", used_in: ["paper.tex Table 2"] });
  expect(saved).toContain("Recorded result D accuracy = 88.1%");
  expect(saved).toContain("Checked: results/v6.json → test.acc holds 0.8812");
  const found = call("anvc_results", { query: "0.881" });
  expect(found).toContain("D accuracy = 88.1% [D] · current");
  expect(found).toContain("results/v6.json → test.acc (unchanged since)");
  expect(found).toContain("used in: paper.tex Table 2");
});

test("the briefing names a locked result whose inputs changed, and a prompt with its number brings it up", async () => {
  const p = project();
  const state = tmp("anvc-results-state-");
  const { id } = recordResult(p.repo, { name: "D accuracy", value: "88.1%", part: "D", source: { path: "results/v6.json", key: "test.acc" }, depends: ["d/model.py"] }, agent);
  recordStatus(p.repo, id, "locked", "Table 2", person);
  writeFileSync(join(p.repo, "d", "model.py"), "D = 3  # changed\n");
  const inject = (event: string, extra: object) => {
    const out = runHook("inject", event, { session_id: `s-${event}`, cwd: p.repo, hook_event_name: event, ...extra }, { ANVC_STATE_DIR: state });
    return out ? out.hookSpecificOutput.additionalContext as string : "";
  };
  const briefing = inject("SessionStart", { source: "startup" });
  expect(briefing).toContain("1 result recorded here, 1 locked");
  expect(briefing).toContain("Results that need a look:");
  expect(briefing).toContain("d/model.py CHANGED");
  const asked = inject("UserPromptSubmit", { prompt: "can we trust the 88.1% in table 2?" });
  expect(asked).toContain("Results this mentions:");
  expect(asked).toContain("D accuracy = 88.1% [D] · LOCKED");
});

test("a path that links out of the repository is refused, and never read or fingerprinted", () => {
  const p = project();
  const outside = tmp("anvc-outside-");
  writeFileSync(join(outside, "secret.json"), JSON.stringify({ token: 12345 }));
  symlinkSync(join(outside, "secret.json"), join(p.repo, "results", "link.json"));
  symlinkSync(outside, join(p.repo, "elsewhere"));
  expect(() => recordResult(p.repo, { name: "t", value: "12345", source: { path: "results/link.json", key: "token" } }, agent)).toThrow("not inside the repository");
  expect(() => recordResult(p.repo, { name: "t", value: "1", depends: ["elsewhere/secret.json"] }, agent)).toThrow("not inside the repository");

  // A record from somewhere else can name one anyway. It counts as missing.
  appendRecord(p.repo, rec({
    intent: { goal: "Result: t = 12345" },
    result: { name: "t", value: "12345", status: "current", source: { path: "results/link.json", key: "token", hash: "sha256:0" }, depends: [{ path: "elsewhere/secret.json", hash: "sha256:0" }] },
  }));
  const view = listResults(p.repo).find((v) => v.name === "t")!;
  expect(checkResult(p.repo, view)).toMatchObject({ source: { state: "missing", now: null }, depends: [{ state: "missing" }] });

  // Inside a folder, a link out of it isn't followed.
  const before = fingerprint(join(p.repo, "results"));
  symlinkSync(join(outside, "secret.json"), join(p.repo, "results", "more.json"));
  expect(fingerprint(join(p.repo, "results"))).toEqual(before);

  writeFileSync(join(outside, "paper.md"), "Accuracy was 88.1%.\n");
  symlinkSync(join(outside, "paper.md"), join(p.repo, "paper.md"));
  expect(tool(p.repo, "anvc_results", { document: "paper.md" })).toBe("paper.md is outside this repository.");
});
