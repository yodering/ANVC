/**
 * A private copy of every session, kept after the agent deletes its own.
 *
 * Claude Code deletes transcripts after 30 days by default, and with them the
 * only record of what was tried in sessions nobody checkpointed. The stop hook
 * copies the session file here at the end of every turn, compressed, so a
 * copy is never more than one turn behind. Codex's and Cursor's session files
 * are kept the same way.
 *
 * Private: under ~/.anvc, never pushed, and off when the project's settings
 * turn session copies off.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { constants, gunzipSync } from "node:zlib";
import { readPolicy } from "./policy";
import { legacyKey, readJson, repoKey, writeJson } from "./rawlog";

export const keptRoot = (): string => process.env.ANVC_KEPT_DIR ?? join(homedir(), ".anvc", "transcripts");

const THROTTLE_MS = 5 * 60_000;

export interface Kept { agent: string; session: string; path: string; bytes: number }

/** Where one session's copy goes. Already-compressed files keep their own format. */
function destination(repo: string, agent: string, session: string, source: string, root: string): string {
  const safe = session.replace(/[^\w.-]/g, "-");
  return join(root, repoKey(repo), agent, source.endsWith(".zst") ? `${safe}.jsonl.zst` : `${safe}.jsonl.gz`);
}

/**
 * Copies a session file if it changed since the last copy. Returns the copy's
 * path, or null when nothing was kept. Never throws: a failed copy must not
 * break the session it is copying.
 */
export function keepSession(repo: string, agent: string, session: string, source: string,
  opts: { root?: string; force?: boolean } = {}): string | null {
  const root = opts.root ?? keptRoot();
  try {
    if (!session || !source || !existsSync(source)) return null;
    if (readPolicy(repo).fields.transcripts === "off") return null;
    const dest = destination(repo, agent, session, source, root);
    if (existsSync(dest)) {
      const copied = statSync(dest).mtimeMs;
      if (copied >= statSync(source).mtimeMs) return dest;
      // A long session is megabytes, and this runs every turn. Once every few
      // minutes is enough while it runs; the session's end copies it for good.
      if (!opts.force && Date.now() - copied < THROTTLE_MS) return dest;
    }
    mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 });
    if (dest.endsWith(".gz") && appendNew(source, dest)) return dest;
    // Without a mark to go on, the whole copy is written again. The mark goes
    // first, so a copy cut short here is never appended to.
    rmSync(markOf(dest), { force: true });
    const raw = readFileSync(source);
    const body = dest.endsWith(".gz") ? Bun.gzipSync(raw) : raw;
    // Written beside and renamed, so a reader never sees half a file.
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, dest);
    if (dest.endsWith(".gz")) mark(dest, raw.length, raw);
    return dest;
  } catch {
    return null;
  }
}

/**
 * How far a copy has read its session file: the file's size then, the copy's
 * size then, and a hash of the file's last few KiB before that point, which
 * tells a file that grew from one that was rewritten.
 *
 * Session files only grow, and a long one is hundreds of megabytes. Writing
 * the whole copy again every few minutes wrote about a gigabyte an hour to
 * disk in a long session. So once a copy exists, only what the file gained
 * is compressed and added to its end. Gzip allows that: a file of several
 * gzip streams reads back as one.
 */
interface Mark { source: number; copy: number; tail: string }
const markOf = (dest: string) => `${dest}.at`;
const TAIL = 4096;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function mark(dest: string, source: number, tail: Uint8Array): void {
  writeJson(markOf(dest), { source, copy: statSync(dest).size, tail: hash(tail.subarray(Math.max(0, tail.length - TAIL))) } satisfies Mark);
}

/** Adds what the session file gained since the last copy. False when the whole copy has to be written. */
function appendNew(source: string, dest: string): boolean {
  const at = readJson<Mark | null>(markOf(dest), null);
  if (!at || !existsSync(dest)) return false;
  const size = statSync(source).size;
  const copy = statSync(dest).size;
  if (size < at.source || copy < at.copy) return false;
  const from = Math.max(0, at.source - TAIL);
  const read = Buffer.alloc(size - from);
  const fd = openSync(source, "r");
  try { readSync(fd, read, 0, read.length, from); } finally { closeSync(fd); }
  const before = read.subarray(0, at.source - from);
  if (hash(before) !== at.tail) return false;
  const added = read.subarray(at.source - from);
  // A copy longer than its mark was cut off partway through an append.
  if (copy > at.copy) truncateSync(dest, at.copy);
  if (added.length) appendFileSync(dest, Bun.gzipSync(added));
  mark(dest, size, read);
  return true;
}

/**
 * A kept copy's text, decompressed. Zstandard copies are skipped: Bun has no
 * decoder for them. node:zlib reads every gzip stream in the file, where
 * Bun.gunzipSync stops after the first, and a sync flush keeps what an
 * append cut off partway still left readable.
 */
export function readKept(path: string): string | null {
  try {
    const raw = readFileSync(path);
    if (path.endsWith(".gz")) return gunzipSync(raw, { finishFlush: constants.Z_SYNC_FLUSH }).toString("utf8");
    if (path.endsWith(".jsonl")) return raw.toString("utf8");
    return null;
  } catch { return null; }
}

/** Every kept copy for a repository. */
export function keptSessions(repo: string, root = keptRoot()): Kept[] {
  const out: Kept[] = [];
  // The folder before its name carried a hash too, for copies kept then.
  for (const base of [join(root, repoKey(repo)), join(root, legacyKey(repo))]) {
    let agents: string[] = [];
    try { agents = readdirSync(base); } catch { continue; }
    for (const agent of agents) {
      let names: string[] = [];
      try { names = readdirSync(join(base, agent)); } catch { continue; }
      for (const name of names) {
        // Beside each copy are its mark (.at) and, while one is written, a .tmp.
        if (!/\.jsonl(\.gz|\.zst)?$/.test(name)) continue;
        const path = join(base, agent, name);
        try { out.push({ agent, session: basename(name).replace(/\.jsonl(\.gz|\.zst)?$/, ""), path, bytes: statSync(path).size }); } catch { /* vanished */ }
      }
    }
  }
  return out;
}
