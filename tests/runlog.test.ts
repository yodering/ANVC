/**
 * A run started by hand with `anvc run` is kept like an agent's command, in a
 * log of its own, so its numbers can be traced and no session picks it up.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { captureFiles, MAX_OUTPUT } from "../protocol/rawlog";
import { runsFiles } from "../protocol/runlog";
import { whence } from "../protocol/results";
import { gitRepo, setEnv, tmp } from "./helpers";

// Skipped on Windows: python3, seq and the bash lines these run may not be there.
test.skipIf(process.platform === "win32")("anvc run passes the output and exit code through, and keeps the run for whence", async () => {
  const repo = gitRepo();
  const home = tmp("anvc-run-home-");
  const env = { ...process.env, ANVC_CAPTURE_DIR: join(home, "capture"), ANVC_STATE_DIR: join(home, "state"), HOME: home };
  mkdirSync(join(repo, "results"));
  writeFileSync(join(repo, "train.py"), 'import json, sys\nprint("val accuracy 0.8812")\njson.dump({"acc": 0.8812}, open(sys.argv[-1], "w"))\n');
  const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../protocol/cli.ts"), ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });

  const ran = cli("run", "--", "python3", "train.py", "--lr", "1e-4", "--out", "results/v6.json");
  expect(ran.exitCode).toBe(0);
  expect(ran.stdout.toString()).toBe("val accuracy 0.8812\n");
  expect(ran.stderr.toString()).toContain("anvc: logged this run, and results/v6.json");
  expect(cli("run", "echo nope; exit 3").exitCode).toBe(3);

  setEnv({ ANVC_CAPTURE_DIR: env.ANVC_CAPTURE_DIR, ANVC_STATE_DIR: env.ANVC_STATE_DIR });
  const [file] = runsFiles(repo);
  const rows = readFileSync(file!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.map((r) => [r.command, r.ok])).toEqual([["python3 train.py --lr 1e-4 --out results/v6.json", true], ["echo nope; exit 3", false]]);
  // Not in the agents' log, so ingest and the briefings never see it.
  expect(captureFiles(repo).filter(existsSync)).toEqual([]);

  const found = whence(repo, "88.1%");
  expect(found.files[0]).toMatchObject({ path: "results/v6.json", key: "acc" });
  expect(found.outputs[0]!.line).toBe("val accuracy 0.8812");
});

test.skipIf(process.platform === "win32")("a long run keeps the end of its output", async () => {
  const repo = gitRepo();
  const home = tmp("anvc-run-home-");
  const env = { ...process.env, ANVC_CAPTURE_DIR: join(home, "capture"), ANVC_STATE_DIR: join(home, "state"), HOME: home };
  setEnv({ ANVC_CAPTURE_DIR: env.ANVC_CAPTURE_DIR, ANVC_STATE_DIR: env.ANVC_STATE_DIR });
  // About 39,000 characters, which the run holds whole, and 109,000, which it
  // holds the start and end of. A failure prints its reason last.
  for (const lines of [8000, 20000]) {
    const ran = Bun.spawnSync(["bun", join(import.meta.dir, "../protocol/cli.ts"), "run", `seq 1 ${lines}`], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    expect(ran.exitCode).toBe(0);
    const { output } = JSON.parse(readFileSync(runsFiles(repo)[0]!, "utf8").trim().split("\n").at(-1)!);
    // The start and the end, and a gap that counts everything between them.
    const printed = Array.from({ length: lines }, (_, i) => `${i + 1}\n`).join("");
    const half = MAX_OUTPUT / 2 - 40;
    expect(output).toBe(`${printed.slice(0, half)}\n\n  [... ${printed.length - half * 2} characters not kept ...]\n\n${printed.slice(-half)}`);
  }
});

test("anvc run keeps quoted arguments and a redirect, through bash or, on Windows, cmd.exe", () => {
  const repo = gitRepo();
  const home = tmp("anvc-run-home-");
  const env = { ...process.env, ANVC_CAPTURE_DIR: join(home, "capture"), ANVC_STATE_DIR: join(home, "state") };
  writeFileSync(join(repo, "echo.ts"), 'console.log(process.argv.slice(2).join("|"));\n');
  const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../protocol/cli.ts"), ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });

  const said = cli("run", "--", "bun", "echo.ts", "a b", 'say "hi"', "c:\\dir\\");
  expect(said.exitCode, said.stderr.toString()).toBe(0);
  expect(said.stdout.toString()).toBe('a b|say "hi"|c:\\dir\\\n');
  expect(cli("run", "bun echo.ts one > out.txt").exitCode).toBe(0);
  expect(readFileSync(join(repo, "out.txt"), "utf8").trim()).toBe("one");
  expect(cli("run", "--", "bun", "-e", "process.exit(3)").exitCode).toBe(3);
});
