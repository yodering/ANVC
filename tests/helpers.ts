/**
 * What most tests set up: a temp folder and environment that are put back
 * when the test finishes, a git repository, a record, rows in the raw log,
 * and the hooks, MCP server, CLI and page's server run the way an agent or a
 * person runs them.
 */
import { onTestFinished } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureFile, captureFiles } from "../protocol/rawlog";
import { appendRecord, ulid, type CheckpointRecord } from "../protocol/record";

const ROOT = resolve(import.meta.dir, "..");

/**
 * A temp folder, removed when the test finishes. Call it inside a test or a
 * beforeEach; in a beforeAll, Bun runs the cleanup before any test starts.
 *
 * On Windows the temp folder can be named with a short 8.3 name such as
 * RUNNER~1, which git and realpath spell out, so there the folder is given
 * resolved. A server or git a test started can still hold a file open there
 * when it's removed, which is no reason to fail the test.
 */
export function tmp(prefix = "anvc-"): string {
  const made = mkdtempSync(join(tmpdir(), prefix));
  const dir = process.platform === "win32" ? realpathSync(made) : made;
  onTestFinished(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* still open */ } });
  return dir;
}

const saved = new Map<string, string | undefined>();
const apply = (vars: Iterable<[string, string | undefined]>) => {
  for (const [key, value] of vars) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/** Sets environment variables until the test finishes. Undefined unsets one. */
export function setEnv(vars: Record<string, string | undefined>): void {
  // Bun runs cleanups first-in first-out, so each variable remembers the value
  // it had before the test's first change, and one cleanup puts them all back.
  if (!saved.size) onTestFinished(() => { apply(saved); saved.clear(); });
  for (const key of Object.keys(vars)) if (!saved.has(key)) saved.set(key, process.env[key]);
  apply(Object.entries(vars));
}

/** Runs git in `dir` as a test identity and returns its output, or throws if it fails. */
export function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

/** A git repository in a temp folder: bare if asked, or with one empty commit. */
export function gitRepo({ bare = false, commit = false } = {}): string {
  const dir = tmp("anvc-repo-");
  git(dir, "init", "-q", ...(bare ? ["--bare"] : []));
  if (commit) git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  return dir;
}

/** A record that passes validation: kept, anchored to a blob, in session "s". */
export const rec = (over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
  session: { agent: "claude-code", run_id: "s" },
  intent: { goal: "work" }, outcome: { status: "kept" },
  ts: new Date().toISOString(), ...over,
} as CheckpointRecord);

/** Writes a record where `git fetch` puts a teammate's, each in its own session so none takes another's ref. */
export function fetched(repo: string, record: CheckpointRecord): void {
  const { ref } = appendRecord(repo, { ...record, session: { agent: record.session.agent, run_id: record.id } });
  git(repo, "update-ref", ref.replace(/^refs\/anvc\//, "refs/remotes/fork/anvc/"), git(repo, "rev-parse", ref));
  git(repo, "update-ref", "-d", ref);
}

/** Everything the capture hook wrote under a raw-log folder, in either layout. */
export const rawText = (root: string): string =>
  captureFiles(null, root).map((f) => readFileSync(f, "utf8")).join("");

export const rawRows = (root: string): Array<Record<string, any>> =>
  rawText(root).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Adds rows to today's raw log for `repo`, each one an empty PostToolUse row unless it says otherwise. */
export function writeCapture(repo: string, rows: object[], root?: string): void {
  const file = captureFile(repo, new Date().toISOString().slice(0, 10), root);
  mkdirSync(dirname(file), { recursive: true });
  // The capture hook names the repository as git does, with symlinks resolved,
  // as they are in macOS's temp folder.
  const top = realpathSync(repo);
  appendFileSync(file, rows.map((r) => JSON.stringify({
    anvc_capture: 0, event: "PostToolUse", ts: new Date().toISOString(), session_id: "s", agent: "claude-code",
    cwd: top, repo: top, tool: null, path: null, bytes: null, command: null, prompt: null, ok: null, ...r,
  })).join("\n") + "\n");
}

/** Runs a hook the way the agent does, payload on stdin, and returns what it printed, parsed. */
export function runHook(script: string, event: string | string[], payload: object, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", join(ROOT, "emitters/claude-code", `${script}.ts`), ...[event].flat()], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const out = p.stdout.toString().trim();
  return out ? JSON.parse(out) as Record<string, any> : null;
}

/** What the inject hook adds to Claude Code's context on this event, if anything. */
export const context = (event: string, payload: object, env: Record<string, string> = {}): string | undefined =>
  runHook("inject", event, payload, env)?.hookSpecificOutput?.additionalContext;

/**
 * The MCP server as Claude Code starts it: setup registers it with
 * ANVC_AGENT set, so a record it writes names the agent.
 */
const AS_CLAUDE = { ANVC_AGENT: "claude-code" };

/** Drives the MCP server over stdio the way a client does, then reads the replies. */
export async function rpc(repo: string, requests: unknown[], env: Record<string, string> = {}): Promise<Map<number, unknown>> {
  const proc = Bun.spawn(["bun", join(ROOT, "protocol/mcp.ts")], {
    stdin: Buffer.from(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    env: { ...process.env, ...AS_CLAUDE, ANVC_REPO: repo, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  const byId = new Map<number, unknown>();
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const msg = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
    byId.set(msg.id, msg.result ?? msg.error);
  }
  return byId;
}

/** Calls one MCP tool and returns the text it answered with. */
export function tool(repo: string, name: string, args: object = {}, env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(["bun", join(ROOT, "protocol/mcp.ts")], {
    stdin: Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`),
    env: { ...process.env, ...AS_CLAUDE, ANVC_REPO: repo, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!).result.content[0].text as string;
}

/** Runs `anvc <args> --repo <repo>` as a person does. `out` is stdout and stderr together, as they'd see it. */
export function cli(repo: string, ...args: string[]): { code: number | null; out: string; stdout: string } {
  const p = Bun.spawnSync(["bun", join(ROOT, "protocol/cli.ts"), ...args, "--repo", repo], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdout = p.stdout.toString();
  return { code: p.exitCode, out: stdout + p.stderr.toString(), stdout };
}

/** fetch with the UI server's token, which tests/preload.ts sets. */
export const uiFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, headers: { "x-anvc-token": process.env.ANVC_UI_TOKEN!, ...(init.headers as Record<string, string>) } });

/** A JSON POST the way the page sends one, with the header only the page sends unless told otherwise. */
export const uiPost = (url: string, body: object, headers: Record<string, string> = { "x-anvc": "1" }): Promise<Response> =>
  uiFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Runs the UI server on `repo` with this environment for as long as `fn` takes. */
export async function served<T>(repo: string, env: Record<string, string | undefined>, fn: (origin: string) => Promise<T>): Promise<T> {
  const proc = Bun.spawn(["bun", join(ROOT, "server/inspect.ts"), "--repo", repo, "--port", "0"], { env, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = proc.stdout.getReader();
    let out = "", match: RegExpMatchArray | null = null;
    while (!(match = out.match(/anvc on (http:\/\/127\.0\.0\.1:\d+)\n/))) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the server exited: ${out}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return await fn(match[1]!);
  } finally { proc.kill(); }
}
