/**
 * A shell command that failed in an earlier session here, found before it
 * runs again.
 *
 * Records reach an agent when a session starts and when a command fails, so
 * the warning about a dead end came after the agent had already run it again.
 * Measured on 54 SWE-bench issues (archive/experiments/x10-swebench): a fresh
 * session hit the earlier session's failures in 96% of runs, and 88% with
 * ANVC's session-start text. Most of those failures are shell commands: a
 * patch format `git apply` rejects, a `pytest` the checkout doesn't have.
 *
 * The raw log already holds every command with whether it worked, so this
 * needs nothing from the agent.
 */
import { captureRows, lastDays } from "./rawlog";
import type { CaptureEvent } from "./ingest";

/** Tools whose second word is the command itself: `git apply`, `npm test`. */
const SUBCOMMANDS = new Set(["git", "npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go", "docker", "make", "conda", "brew", "apt", "apt-get"]);

/** Commands that only look, and never count as an approach. */
const LOOKING = new Set(["ls", "cat", "head", "tail", "less", "grep", "rg", "find", "wc", "nl", "echo", "pwd", "cd", "which", "file", "stat", "tree", "diff", "true"]);

const PATHY = /^[\w./-]+\.[A-Za-z0-9]{1,5}$|\//;

/** The first line of a command without a leading `cd somewhere &&` or `VAR=value`. */
function firstLine(command: string): string[] {
  let line = command.split("\n")[0]!.trim();
  line = line.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "");
  const words = line.split(/\s+/).filter(Boolean);
  while (words.length && /^\w+=/.test(words[0]!)) words.shift();
  return words;
}

/**
 * What makes two commands the same attempt: the tool, its subcommand where it
 * has one, a module for `python -m`, and the files it names. Null for a
 * command that only looks.
 */
export function commandKey(command: string): { tool: string; key: string } | null {
  const words = firstLine(command);
  const tool = words[0]?.split("/").at(-1);
  if (!tool || LOOKING.has(tool) || (tool === "sed" && words.includes("-n"))) return null;
  const rest = words.slice(1).filter((w) => !w.startsWith("-") && !/^<<|^['"]?[A-Z]+['"]?$/.test(w));
  if (SUBCOMMANDS.has(tool)) return { tool, key: [tool, rest[0] ?? ""].join(" ").trim() };
  if (/^python[\d.]*$/.test(tool)) {
    const module = words.indexOf("-m");
    if (module > 0 && words[module + 1]) return { tool, key: `python -m ${words[module + 1]}` };
    return { tool, key: ["python", ...rest.filter((w) => PATHY.test(w)).sort()].join(" ") };
  }
  return { tool, key: [tool, ...rest.filter((w) => PATHY.test(w)).sort()].join(" ") };
}

/** The line a person would quote from a failure: its last error line, else its last line. */
export function errorOf(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return ([...lines].reverse().find((l) => /error|not found|failed|exception/i.test(l)) ?? lines.at(-1) ?? "").slice(0, 200);
}

export interface Repeat {
  key: string;
  command: string;
  error: string;
  ts: string;
  /** The next command that session ran without an error, if it didn't only look. */
  after: string | null;
}

/**
 * The latest failure of the same attempt in another session of this
 * repository, which that session never got to work afterwards. A tool that
 * wasn't installed matches any later use of it.
 */
export function failedBefore(root: string, session: string, command: string, days = 30): Repeat | null {
  const here = commandKey(command);
  if (!here) return null;
  const missing = (r: CaptureEvent) => /command not found|No such file or directory|not recognized as/i.test(r.output ?? "");
  // Rows naming the tool, to find the failures cheaply; latest first.
  const failures = captureRows(root, undefined, lastDays(days), [here.tool])
    .filter((r) => r.tool === "Bash" && r.ok === false && r.command && r.session_id && r.session_id !== session)
    .filter((r) => {
      const there = commandKey(r.command!);
      return there !== null && (missing(r) ? there.tool === here.tool : there.key === here.key);
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
  for (const r of failures) {
    // That session's whole log, for what it did after the failure.
    const list = captureRows(root, undefined, lastDays(days), [JSON.stringify(r.session_id)])
      .filter((l) => l.session_id === r.session_id && l.tool === "Bash" && l.command)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const at = list.findIndex((l) => l.ts === r.ts && l.command === r.command);
    const later = list.slice(at + 1);
    const key = commandKey(r.command!)!.key;
    // Tried again later in that session and it worked: not a dead end.
    if (later.some((l) => l.ok === true && commandKey(l.command!)?.key === key)) continue;
    const next = later.find((l) => l.ok === true && commandKey(l.command!) !== null);
    return { key, command: r.command!.split("\n")[0]!.slice(0, 160), error: errorOf(r.output ?? ""), ts: r.ts, after: next ? next.command!.split("\n")[0]!.slice(0, 160) : null };
  }
  return null;
}

/** What the agent is told when the command is stopped. */
export function repeatReason(r: Repeat): string {
  return `anvc: \`${r.command}\` failed in an earlier session here on ${r.ts.slice(0, 10)}${r.error ? `, with "${r.error}"` : ""}. That session did not get it to work.`
    + (r.after ? ` After it, that session ran \`${r.after}\` without an error.` : "")
    + " ANVC stopped it this once. If something changed since then, run it again."
}
