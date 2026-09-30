/**
 * Where the raw log lives: one folder per repository, one file per day.
 *
 * It was one file per day for every repository at once, so anything asking
 * about one project read every project's events to find its own, and a
 * project's history could not be kept, moved or deleted on its own. Files
 * written before the split stay where they are and are still read; each row
 * carries its repository, so they are filtered rather than migrated.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CaptureEvent } from "./ingest";

export const captureRoot = (): string => process.env.ANVC_CAPTURE_DIR ?? join(homedir(), ".anvc", "capture");
/** What the hooks remember between runs: what a session was told, checks already run. */
export const stateRoot = (): string => process.env.ANVC_STATE_DIR ?? join(homedir(), ".anvc", "state");
/** One row per hook run, shown or not; see inject.ts. */
export const metricsRoot = (): string => process.env.ANVC_METRICS_DIR ?? join(homedir(), ".anvc", "metrics");

const readable = (repo: string): string => repo.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]/g, "-");

/**
 * A repository's folder name: its path made safe for a name, then a hash of
 * the exact path. The safe name alone gave /x/my-app, /x/my_app and /x/my/app
 * one folder, and sync shipped whatever that folder held as one project's.
 */
export const repoKey = (repo: string): string => {
  const path = samePath(repo);
  return `${readable(path)}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
};

/**
 * A path with its symlinks resolved, so one repository has one key however it
 * was reached. On macOS git names /var/folders as /private/var/folders, and a
 * hook keyed by git's answer missed a caller keyed by the path it was given.
 * A path that doesn't exist here, such as one synced from another machine, is
 * kept as it is. On Windows one folder is C:\x, c:\x and C:/x, the last from
 * git, so there the slashes and the drive letter are made one way too.
 */
/**
 * A path with its links resolved. On Windows the native call also spells out
 * a short name such as RUNNER~1, which the JavaScript one leaves as it is,
 * while git reports the long name.
 */
const real = process.platform === "win32" ? realpathSync.native : realpathSync;

export function samePath(path: string): string {
  // An empty path names no folder; realpathSync("") would answer the current one.
  if (!path) return path;
  let resolved = path;
  try { resolved = real(path); } catch { /* kept as it is */ }
  return process.platform === "win32" ? normalize(resolved).replace(/^[a-z](?=:)/, (d) => d.toUpperCase()) : resolved;
}

/**
 * Whether a row's repository is this one once both paths are resolved. A log
 * holds a handful of distinct paths, so each is resolved once.
 */
export function isRepo(repo: string): (value: unknown) => boolean {
  const real = samePath(repo);
  const seen = new Map<string, boolean>();
  return (value) => {
    if (typeof value !== "string") return false;
    if (value === repo || value === real) return true;
    let hit = seen.get(value);
    if (hit === undefined) seen.set(value, hit = samePath(value) === real);
    return hit;
  };
}

/**
 * `path` relative to `base` the way git writes it, with / between folders, or
 * null when it isn't below `base`. A prefix test with / found nothing on
 * Windows, where Node writes \ and git writes C:/; relative() resolves both
 * paths, so `a/../../etc/passwd` is outside, and compares Windows paths
 * without regard to case, as Windows does.
 */
export function below(base: string, path: string): string | null {
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** A path relative to the repository, symlinks resolved, or null when it's outside. */
export function inRepo(repo: string): (path: string | null | undefined) => string | null {
  const real = samePath(repo);
  return (given) => given ? below(repo, given) ?? below(real, given) ?? below(real, resolveExisting(resolve(given))) : null;
}

/**
 * A path in the repository, relative or absolute, with its symlinks resolved,
 * or null when it resolves outside. For anything about to be read or
 * fingerprinted: a link inside the repository can point anywhere on this
 * computer, and a record naming one can come from anyone who can push.
 */
export function realInside(repo: string, path: string): string | null {
  const root = samePath(repo);
  const real = resolveExisting(resolve(repo, path));
  return below(root, real) === null ? null : real;
}

/** Resolves the deepest folder of a path that exists, for a file since deleted or never written. */
function resolveExisting(path: string): string {
  const parent = dirname(path);
  try { return real(path); } catch { /* resolve what's above it */ }
  return parent === path ? path : join(resolveExisting(parent), basename(path));
}

/** The folder name before the hash was added. Still read, never written; rows in it are filtered by repository. */
export const legacyKey = readable;

/** The names of the last `n` days' files, today's first. */
export const lastDays = (n: number, now = Date.now()): string[] =>
  Array.from({ length: n }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10));

/** The file a row for this repository and day is appended to. Rows outside any repository keep the old place. */
export function captureFile(repo: string | null, day: string, root = captureRoot()): string {
  return repo ? join(root, repoKey(repo), `${day}.jsonl`) : join(root, `${day}.jsonl`);
}

/** The .jsonl files in a folder, by name. */
export const jsonl = (dir: string): string[] => {
  try { return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => join(dir, n)); } catch { return []; }
};

/** A JSONL file's rows. A line that doesn't parse is skipped: a hook writing at that moment can leave half of one. */
export function readJsonl<T>(file: string, mentions?: string[]): T[] {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    // Parsing is the cost; most lines of a day's log are other sessions'.
    if (!line || (mentions && !mentions.some((m) => line.includes(m)))) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row as T);
    } catch { /* half a line */ }
  }
  return rows;
}

/** A JSON file's value, or `fallback` when it is missing or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}

/**
 * Writes a settings file the way people read it, making its folder first.
 *
 * Readable by this user only, like every file anvc writes under ~/.anvc:
 * with the default umask they were readable by everyone on the machine, and
 * they hold prompts, command output and session transcripts. The mode applies
 * when a file or folder is created.
 */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * What the local UI asks every request for. Made on first use and kept, so a
 * bookmarked link still works after a restart. ANVC_UI_TOKEN overrides it:
 * the desktop app passes a fresh one each launch.
 */
export function uiToken(): string {
  if (process.env.ANVC_UI_TOKEN) return process.env.ANVC_UI_TOKEN;
  const file = join(stateRoot(), "ui-token");
  const kept = (() => { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } })();
  if (/^[0-9a-f]{64}$/.test(kept)) return kept;
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * What a server answers to show it holds the token without sending it. The
 * port is in it, so a process squatting one port can't pass along the answer
 * of a real server on another.
 */
export const tokenProof = (token: string, port: number, nonce: string): string =>
  createHmac("sha256", token).update(`anvc-ui ${port} ${nonce}`).digest("hex");

/**
 * Raw log files that can hold a repository's rows: its own folder, then the
 * shared files from before the split. With no repository, every file.
 * Callers still filter rows by `repo`, since the shared files hold everyone's.
 */
export function captureFiles(repo?: string | null, root = captureRoot(), days?: string[]): string[] {
  const pick = (files: string[]) => days ? files.filter((f) => days.includes(basename(f, ".jsonl"))) : files;
  const flat = pick(jsonl(root));
  if (repo) return [...pick(jsonl(join(root, repoKey(repo)))), ...pick(jsonl(join(root, legacyKey(repo)))), ...flat];
  let dirs: string[] = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)); } catch { /* no log yet */ }
  return [...dirs.flatMap((d) => pick(jsonl(d))), ...flat];
}

/** This repository's rows in the raw log, file by file, only from `days` when given. */
export function captureRows(repo: string, root?: string, days?: string[], mentions?: string[]): CaptureEvent[] {
  const here = isRepo(repo);
  return captureFiles(repo, root, days).flatMap((file) => readJsonl<CaptureEvent>(file, mentions)).filter((row) => here(row.repo));
}

/**
 * How much of a command's output to keep.
 *
 * Generous on purpose. This is the layer that lets someone resolve, months
 * later, a bug nobody noticed at the time — and the only thing that can settle
 * whether a recorded dead end was a real constraint or a bad afternoon is what
 * was actually observed, rather than anyone's account of it.
 *
 * Until now the hook received `tool_response` carrying the real stderr and
 * stored a single boolean off it. Three thousand commands captured, none of
 * their results: exactly the write-time compression this project criticises in
 * other systems.
 */
export const MAX_OUTPUT = 16 * 1024;

/**
 * Output as the raw log keeps it: redraws and repeats collapsed, and head and
 * tail when it is long.
 *
 * Trimmed by shape, never by judgement. The distinction that matters: drop
 * what is *structurally* noise — a progress bar redrawn four hundred times, an
 * unchanged middle — and never drop something merely because it looks
 * unimportant now. A confusing stack trace is precisely what a reader needs in
 * three months, and a summarizer deciding it was not interesting is how that
 * gets lost.
 *
 * So every rule here is mechanical and statable, and anything near an error is
 * exempt from all of them.
 */
export function trimOutput(text: string, cap = MAX_OUTPUT): string {
  const kept = collapse(text);
  return text.length <= cap ? kept : headTail(kept, cap);
}

/**
 * Output scrubbed, then trimmed by shape. The scrub has a cap of its own, and
 * cutting there kept only the head, so a failure printed at the end of long
 * output was lost. Past that cap the head and the tail are kept first.
 */
export function keepOutput(text: string, scrub: (text: string, cap?: number) => string): string {
  const cap = MAX_OUTPUT * 2;
  return trimOutput(scrub(text.length > cap ? headTail(text, MAX_OUTPUT) : text, cap));
}

/**
 * The head and the tail of a long text, with the gap named. A failure
 * announces itself at the end and the command that caused it is at the start.
 * The gap says what it swallowed, so a reader knows the difference between
 * "nothing happened" and "not kept".
 */
export function headTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2) - 40;
  return `${text.slice(0, half)}\n\n  [... ${text.length - half * 2} characters not kept ...]\n\n${text.slice(-half)}`;
}

/**
 * Repeated identical lines, and carriage-return redraws of one line.
 *
 * A progress bar is not identical line to line — that is the point of it — so
 * collapsing only exact repeats leaves forty near-copies of the same bar. What
 * makes it noise is the `\r`: the writer intended one line that kept being
 * overwritten, and only its final state was ever meant to be seen. Splitting
 * on `\r` into separate lines gets that exactly backwards.
 */
function collapse(text: string): string {
  const lines = text.split("\n").flatMap((line) => {
    if (!line.includes("\r")) return [line];
    // Only the last redraw of a rewritten line carries information, and the
    // count says how much motion is not being shown.
    const frames = line.split("\r").filter(Boolean);
    return frames.length > 2
      ? [`${frames.at(-1)}  [after ${frames.length - 1} redraws of this line]`]
      : [frames.at(-1) ?? ""];
  });
  const out: string[] = [];
  let run = "";
  let n = 0;
  const flush = () => {
    if (!n) return;
    out.push(run);
    // Two of a thing is not repetition worth naming; four hundred is.
    if (n > 2) out.push(`  [the previous line repeated ${n - 1} more times]`);
    else for (let i = 1; i < n; i++) out.push(run);
    n = 0;
  };
  for (const line of lines) {
    if (line === run) { n++; continue; }
    flush();
    run = line;
    n = 1;
  }
  flush();
  return out.join("\n");
}
