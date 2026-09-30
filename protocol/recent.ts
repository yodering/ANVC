/**
 * The repositories setup offers to set ANVC up in: the ones the person's
 * agents worked in lately, newest first, then the others in the folders
 * where people usually keep projects. Setup used to ask for a path, starting
 * from ANVC's own folder, so the person had to remember where each project was.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexMeta, codexSessions } from "./backfill";
import { folders } from "./folders";
import { findRepos } from "./found";
import { gitOrNull } from "./git";
import { samePath } from "./rawlog";
import { claudeDir, codexDir } from "./version";

export interface Candidate {
  repo: string;
  /** When an agent last worked in it, in milliseconds, or null for one only found on disk. */
  used: number | null;
  /** The agent that did, or ANVC for a folder it ran in. */
  by: string | null;
}

/** Folders under home where projects usually are, looked in two levels deep. */
const USUAL = ["Desktop", "Documents", "code", "Code", "src", "projects", "Projects", "Developer", "dev", "repos", "git", "Gits", "GitHub", "work"];

/** How many of each agent's newest sessions are read. */
const SESSIONS = 40;

/** The first working folder named in a session file's opening 64 KiB. */
function firstCwd(file: string): string | null {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
      for (const line of text.split("\n")) {
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === "string" && cwd) return cwd;
        } catch { /* a line cut off at the end, or not JSON */ }
      }
    } finally { closeSync(fd); }
  } catch { /* unreadable */ }
  return null;
}

const mtime = (path: string) => { try { return statSync(path).mtimeMs; } catch { return 0; } };

/** Each Claude Code project folder's newest session: where it ran, and when. */
function claudeSessions(): Array<{ cwd: string | null; at: number }> {
  const root = join(claudeDir(), "projects");
  let dirs: string[] = [];
  try { dirs = readdirSync(root).map((d) => join(root, d)); } catch { return []; }
  return dirs.map((d) => ({ d, at: mtime(d) })).sort((a, b) => b.at - a.at).slice(0, SESSIONS).flatMap(({ d }) => {
    let files: string[] = [];
    try { files = readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => join(d, f)); } catch { return []; }
    const newest = files.map((f) => ({ f, at: mtime(f) })).sort((a, b) => b.at - a.at)[0];
    return newest ? [{ cwd: firstCwd(newest.f), at: newest.at }] : [];
  });
}

/**
 * The repositories to offer, newest use first, then those only found on
 * disk by name. `exclude` leaves some out, such as ANVC's own clone.
 */
export function candidates(exclude: string[] = [], limit = 40): Candidate[] {
  const skip = new Set(exclude.map(samePath));
  const seen = new Map<string, Candidate>();
  const tops = new Map<string, string | null>();
  const top = (dir: string) => {
    if (!tops.has(dir)) tops.set(dir, existsSync(dir) ? gitOrNull(dir, ["rev-parse", "--show-toplevel"])?.trim() || null : null);
    return tops.get(dir)!;
  };
  const add = (repo: string | null, used: number | null, by: string | null) => {
    if (!repo) return;
    const key = samePath(repo);
    if (skip.has(key)) return;
    const had = seen.get(key);
    if (!had || (used ?? 0) > (had.used ?? 0)) seen.set(key, { repo: key, used, by });
  };
  for (const s of claudeSessions()) if (s.cwd) add(top(s.cwd), s.at, "Claude Code");
  const codex = codexSessions(join(codexDir(), "sessions")).slice(-SESSIONS);
  for (const path of codex) { const cwd = codexMeta(path).cwd; if (cwd) add(top(cwd), mtime(path), "Codex"); }
  for (const f of folders()) add(existsSync(f.repo) ? f.repo : null, Date.parse(f.seen), "ANVC");
  const roots = USUAL.map((name) => join(homedir(), name)).filter((dir) => existsSync(dir));
  for (const repo of findRepos(roots, { depth: 2, repos: 200, ms: 1500 }).repos) add(repo, null, null);
  return [...seen.values()]
    .sort((a, b) => (b.used ?? 0) - (a.used ?? 0) || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}

/** How long ago, said the way a person would: "just now", "3 hours ago", "yesterday". */
export function ago(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
