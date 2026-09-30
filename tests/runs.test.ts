/**
 * What a command wrote and read, taken from the command itself, and what that
 * makes possible: a number found inside a file leads back to the run that
 * wrote it, and a recorded result fills in how it was made.
 */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listResults, recordResult, whence } from "../protocol/results";
import { flags, onlyReads, runFiles, words } from "../protocol/runs";
import { gitRepo, rawRows, runHook, setEnv, tmp, writeCapture } from "./helpers";

function project() {
  const repo = gitRepo();
  for (const d of ["results", "logs", "runs/v6", "data"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, "eval.py"), "print(1)\n");
  writeFileSync(join(repo, "data", "test.csv"), "x\n1\n");
  writeFileSync(join(repo, "runs", "v6", "model.pt"), "weights");
  writeFileSync(join(repo, "results", "v6.json"), JSON.stringify({ test: { acc: 0.8812 } }));
  writeFileSync(join(repo, "logs", "eval.log"), "done\n");
  return { repo };
}

const COMMAND = "python eval.py --ckpt runs/v6 --data data/test.csv --lr=1e-4 --out results/v6.json > logs/eval.log";

test("a command's outputs are what it names as outputs, and its inputs the other files it names", async () => {
  const p = project();
  expect(words('python a.py --name "two words" > out.txt')).toEqual(["python", "a.py", "--name", "two words", ">", "out.txt"]);
  expect(flags(COMMAND)).toEqual({ ckpt: "runs/v6", data: "data/test.csv", lr: "1e-4", out: "results/v6.json" });
  const files = runFiles(COMMAND, p.repo, p.repo);
  expect(files.outputs.map((f) => f.path).sort()).toEqual(["logs/eval.log", "results/v6.json"]);
  // runs/v6 is a folder, which isn't fingerprinted as an input.
  expect(files.inputs.map((f) => f.path).sort()).toEqual(["data/test.csv", "eval.py"]);
  expect(files.outputs[0]!.hash).toMatch(/^sha256:/);
  // After a cd, relative paths are relative to somewhere unknown.
  expect(runFiles(`cd elsewhere && ${COMMAND}`, p.repo, p.repo).outputs).toEqual([]);
});

test("the capture hook keeps a command's files in the raw log", async () => {
  const p = project();
  const log = tmp("anvc-runs-log-");
  runHook("capture", "PostToolUse", { session_id: "s", cwd: p.repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: COMMAND }, tool_response: { stdout: "" } },
    { ANVC_CAPTURE_DIR: log });
  const [row] = rawRows(log);
  expect(row.outputs.map((o: { path: string }) => o.path).sort()).toEqual(["logs/eval.log", "results/v6.json"]);
});

test("a number inside a written file leads back to the run, and a result fills in how it was made", async () => {
  const p = project();
  setEnv({ ANVC_CAPTURE_DIR: tmp("anvc-runs-log-") });
  const { outputs, inputs } = runFiles(COMMAND, p.repo, p.repo);
  writeCapture(p.repo, [{ session_id: "s0", tool: "Bash", command: COMMAND, output: "", outputs, inputs }]);

  const found = whence(p.repo, "88.1%");
  expect(found.files[0]).toMatchObject({ path: "results/v6.json", key: "test.acc", found: "0.8812", changed: false });
  expect(found.files[0]!.command).toStartWith("python eval.py --ckpt runs/v6");

  const saved = recordResult(p.repo, { name: "accuracy", value: "88.1%", source: { path: "results/v6.json", key: "test.acc" } }, { kind: "agent", agent: "claude-code", session: "s1" });
  expect(saved.notes.join(" ")).toContain("Command taken from the log");
  const [view] = listResults(p.repo);
  expect(view!.command).toBe(COMMAND);
  expect(view!.settings).toMatchObject({ lr: "1e-4", ckpt: "runs/v6" });
  expect(view!.depends.map((d) => d.path).sort()).toEqual(["data/test.csv", "eval.py"]);

  // Something else overwrote the file since that run.
  writeFileSync(join(p.repo, "results", "v6.json"), JSON.stringify({ test: { acc: 0.8812, note: "edited" } }));
  expect(whence(p.repo, "0.8812").files[0]!.changed).toBe(true);
});

test("a command that only reads files isn't where a number came from", () => {
  expect(onlyReads("cd experiments && ls x5; head -60 x5/README.md 2>/dev/null")).toBe(true);
  expect(onlyReads(`git grep -n "tier" -- '*.md' | grep -v "^docs"`)).toBe(true);
  expect(onlyReads("for f in *.json; do cat $f; done")).toBe(true);
  expect(onlyReads("tail -n 1 mini.log | cat; python3 analyze.py mini.jsonl")).toBe(false);
  expect(onlyReads(`until [ "$(cat a.jsonl | wc -l)" -ge 100 ]; do sleep 30; done; python3 analyze.py a.jsonl`)).toBe(false);
  expect(onlyReads("cat > c.py <<'EOF'\nimport json\nEOF\npython3 c.py")).toBe(false);
});

test("whence matches a count only as a whole pair, and keeps rereads apart", async () => {
  const p = project();
  setEnv({ ANVC_CAPTURE_DIR: tmp("anvc-runs-log-") });
  const row = (ts: string, command: string, output: string) => ({ session_id: "s0", ts, tool: "Bash", command, output });
  writeCapture(p.repo, [
    row("2026-09-01T10:00:00Z", "cat notes.md", "| old table | **0/50** |"),
    row("2026-09-01T11:00:00Z", "python3 analyze.py run.jsonl", "S1 stale  10/50\nS2 stale  0/50\n"),
    row("2026-09-01T12:00:00Z", "pip install torch", "Downloading [=====     ] 2%"),
    row("2026-09-02T09:00:00Z", "bun trace.ts", "first print:\nS2 stale  0/50\n"),
    row("2026-09-03T09:00:00Z", "python3 analyze.py run2.jsonl", "S1 stale  10/50\nS2 stale  0/50 1.2\n"),
  ]);
  const found = whence(p.repo, "0/50");
  // A rerun whose row starts the same is a run of its own.
  expect(found.outputs.map((o) => o.line)).toEqual(["S2 stale  0/50", "S2 stale  0/50 1.2"]);
  // The second is a script that printed the first run's line back.
  expect(found.reads.map((o) => o.command)).toEqual(["cat notes.md", "bun trace.ts"]);
  expect(whence(p.repo, "0.02").outputs).toEqual([]);
});
