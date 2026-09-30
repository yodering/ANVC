/**
 * `bun run ui` has to show the repository it was pointed at.
 *
 * It passed its own working directory, which is always the ANVC checkout, so
 * after `setup` on another repository the UI showed ANVC's log and nothing
 * said so. Found on the yodermon trial. It is `anvc open` now, which needs no
 * bash, so it runs the same way on Windows.
 *
 * Every server here binds in 7540-7559, clear of open.test.ts's range.
 */
import { expect, onTestFinished, test } from "bun:test";
import { copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { recordFile, type Running } from "../protocol/open";
import { readJson } from "../protocol/rawlog";
import { git, gitRepo, tmp, uiFetch, uiPost } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");
const PORTS = "7540-7559";

const running = (repo: string) => readJson<Running | null>(recordFile(repo), null);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Runs `bun run ui` from the clone, as a person does, and stops what it started when the test ends. */
function ui(repo: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", "run", "ui", ...args, "--port", PORTS, "--no-browser"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  onTestFinished(() => { try { process.kill(running(repo)!.pid); } catch { /* already gone */ } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** The repository the server behind a printed link shows. */
async function shown(out: string): Promise<string> {
  const link = new URL(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/.exec(out)![0]);
  // The link carries the token, so it signs in.
  expect(link.searchParams.get("t")).toBe(process.env.ANVC_UI_TOKEN!);
  const repo = await uiFetch(`${link.origin}/api/repo`).then((r) => r.json()) as { name: string };
  return repo.name;
}

test("--repo picks the repository, and --no-browser prints a link that signs in", async () => {
  const repo = gitRepo({ commit: true });
  const run = ui(repo, "--repo", repo);
  expect(run.code, run.err).toBe(0);
  expect(await shown(run.out)).toBe(basename(repo));
}, 30_000);

test("without --repo, it shows this checkout", async () => {
  const run = ui(ROOT);
  expect(run.code, run.err).toBe(0);
  expect(await shown(run.out)).toBe(basename(ROOT));
}, 30_000);

test("--restart replaces the project's server with a new one", async () => {
  const repo = gitRepo({ commit: true });
  expect(ui(repo, "--repo", repo).code).toBe(0);
  const first = running(repo)!.pid;
  const run = ui(repo, "--repo", repo, "--restart");
  expect(run.code, run.err).toBe(0);
  expect(await shown(run.out)).toBe(basename(repo));
  expect(running(repo)!.pid).not.toBe(first);
  expect(alive(first)).toBe(false);
}, 30_000);

test("the Update button restarts a clone's server on the same port", async () => {
  // A clone one commit behind the repository it pulls from, running this
  // working tree's server and launcher.
  const root = tmp("anvc-restart-");
  const up = join(root, "up.git"), home = join(root, "anvc");
  git(root, "clone", "-q", "--bare", ROOT, up);
  git(root, "clone", "-q", up, home);
  for (const file of ["server/inspect.ts", "protocol/open.ts"]) copyFileSync(join(ROOT, file), join(home, file));
  git(home, "commit", "-q", "--allow-empty", "-am", "Launcher under test");
  git(home, "commit", "-q", "--allow-empty", "-m", "Newer");
  git(home, "push", "-q", "origin", "HEAD");
  git(home, "reset", "-q", "--hard", "HEAD~1");
  symlinkSync(join(ROOT, "node_modules"), join(home, "node_modules"), "junction");
  // No installs to set up again, and no real Claude Code for the update to
  // find, on the PATH or in ~/.local/bin.
  const PATH = [Bun.which("bun")!, Bun.which("git")!].map(dirname).join(delimiter);
  const repo = gitRepo({ commit: true });
  const old = Bun.spawn(["bun", join(home, "server/inspect.ts"), "--repo", repo, "--port", "0"], {
    env: { ...process.env, PATH, HOME: root, ANVC_STATE_HOME: join(root, "state") }, stdout: "pipe", stderr: "pipe",
  });
  onTestFinished(() => old.kill());
  const reader = old.stdout.getReader();
  let out = "", origin: string | undefined;
  while (!(origin = /anvc on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1])) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the server exited: ${out}`);
    out += new TextDecoder().decode(value);
  }
  const answer = await (await uiPost(`${origin}/api/update`, {})).json() as { restart: boolean; lines: string[] };
  expect(answer.restart, answer.lines.join("\n")).toBe(true);
  await old.exited;
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    pid = await uiFetch(`${origin}/api/open`, { method: "POST" }).then((r) => r.json(), () => ({ pid: 0 })).then((r) => r.pid);
    if (!pid) await Bun.sleep(100);
  }
  onTestFinished(() => { try { process.kill(pid); } catch { /* already gone */ } });
  expect(pid).not.toBe(0);
  expect(pid).not.toBe(old.pid);
  expect(git(home, "log", "-1", "--format=%s")).toBe("Newer");
}, 60_000);

test("a folder outside any git repository is refused", () => {
  const run = ui(tmpdir(), "--repo", join(tmpdir(), "anvc-no-such-repo"));
  expect(run.code).toBe(1);
  expect(run.err).toContain("isn't in a git repository");
});
