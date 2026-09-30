/**
 * What changed, since a record was written, in the code the record relies on.
 *
 * A record says what was true when it was written. Telling an agent that a
 * file changed since doesn't stop it following a stale record, in words or as
 * a mark. Evidence does: the result of the record's own check, in words. Most
 * records have no check the hook can run, so this is the other kind of evidence: the lines
 * themselves.
 *
 * Only changes inside a function, class or assignment the record names, or
 * lines that name one, so a busy file's unrelated edits don't bury it. The
 * enclosing name comes from git's own hunk header.
 */
import { changedSince, type Hit } from "./query";
import { gitOrNull } from "./git";

/**
 * Names a record mentions that look like code: sizes.UNITS, get_page,
 * fetchAll. A bare capitalised word is left out: in prose it is ANVC or
 * README far more often than a constant, and matched every README edit.
 */
export function codeNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const found of text.match(/[A-Za-z_][\w.]*/g) ?? []) {
    // A sentence's full stop isn't a dot in a name: "caught them." matched
    // every README line with "them" in it.
    const word = found.replace(/\.+$/, "");
    const last = word.split(".").filter(Boolean).at(-1) ?? "";
    if (last.length < 3) continue;
    if (word.includes(".") || last.includes("_") || /[a-z][A-Z]/.test(last)) names.add(last);
  }
  return names;
}

/**
 * A comment or a docstring line: what the code says about itself, not what it
 * does. Alone, it is no evidence of change: a reworded docstring on a helper
 * that was still broken, shown as one, sent an agent to the helper first.
 * Beside a code change it is often the plainest account of it ("KB is 1000
 * bytes, KiB is 1024"), and without it a stale kept record misleads.
 */
function prose(body: string): boolean {
  return /^(#|\/\/|\/\*|\*|"""|'''|<!--)/.test(body) || (/("""|''')$/.test(body) && !/[=(]/.test(body));
}

const PROSE_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

/** How soon after a kept record its own work is taken to be committed. */
const OWN_WORK_MS = 6 * 3_600_000;

/**
 * Where to measure change from.
 *
 * A dead end's anchor is the commit it was tried against. A kept record is
 * often written before its own work is committed, so from its anchor the work
 * itself reads as a change since. Its work is taken to be the last commit to
 * its files within six hours of the record; with none, a record younger than
 * that may still have its work uncommitted, and shows nothing rather than
 * mistake that work for a later change. Wrong in the other direction, it
 * misses a change for a few hours, which is how it behaved before.
 */
function base(repo: string, hit: Hit): string | null {
  const anchor = hit.anchor.slice("commit:".length);
  if (hit.status === "abandoned") return anchor;
  const at = Date.parse(hit.ts);
  if (Number.isNaN(at)) return null;
  const own = gitOrNull(repo, ["log", "--format=%H", `--since=${new Date(at - 60_000).toISOString()}`,
    `--until=${new Date(at + OWN_WORK_MS).toISOString()}`, `${anchor}..HEAD`, "--", ...hit.files]);
  const landed = own?.split("\n").filter(Boolean)[0];
  if (landed) return landed;
  return Date.now() - at < OWN_WORK_MS ? null : anchor;
}

/** Changed lines, as "file: - old" and "file: + new", at most `cap` of them. */
export function changedLines(repo: string, hit: Hit, cap = 8): string[] {
  if (!hit.files.length || !hit.anchor.startsWith("commit:")) return [];
  const from = base(repo, hit);
  if (!from) return [];
  const moved = changedSince(repo, { ...hit, anchor: `commit:${from}` });
  if (!moved.length) return [];
  const names = [...codeNames(`${hit.intent} ${hit.why ?? ""} ${hit.errors.join(" ")}`)];
  if (!names.length) return [];
  const diff = gitOrNull(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", from, "--", ...moved]) ?? "";
  const out: string[] = [];
  let file = "", fn = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.replace(/^\+\+\+ (b\/)?/, ""); continue; }
    // Prose files say what the project is, not what its code does, and README
    // edits were the false alarms on real records.
    if (PROSE_FILE.test(file)) continue;
    if (line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    // Git names the line above a hunk as its function for any file, prose
    // included, so it counts only when it is a definition.
    if (line.startsWith("@@")) {
      const header = line.replace(/^@@[^@]*@@\s?/, "");
      fn = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|const|let|var|fn|func|pub|type|interface)\b|^[A-Za-z_][\w.]*\s*=/.test(header) ? header : "";
      continue;
    }
    if (line[0] !== "+" && line[0] !== "-") continue;
    const body = line.slice(1).trim();
    if (!body) continue;
    if (names.some((n) => fn.includes(n) || body.includes(n))) {
      out.push(`${file}: ${line[0]} ${body.slice(0, 100)}`);
      if (out.length >= cap) break;
    }
  }
  const kept = withoutMoves(repo, out);
  // Only prose changed: nothing the code does is different.
  return kept.some((l) => !prose(l.slice(l.indexOf(": ") + 4))) ? kept : [];
}

/**
 * Drops removed lines whose exact text still exists somewhere in the working
 * tree: code that moved, not code that changed. A refactor that carried a
 * function to another file read as the record's code having changed, when
 * what it relied on was intact.
 */
function withoutMoves(repo: string, lines: string[]): string[] {
  const removed = lines.filter((l) => l.includes(": - ")).map((l) => l.slice(l.indexOf(": - ") + 4));
  if (!removed.length) return lines;
  const args = removed.flatMap((t) => ["-e", t]);
  const found = new Set((gitOrNull(repo, ["grep", "--untracked", "-h", "-F", ...args]) ?? "").split("\n").map((l) => l.trim()));
  return lines.filter((l) => !l.includes(": - ") || !found.has(l.slice(l.indexOf(": - ") + 4)));
}
