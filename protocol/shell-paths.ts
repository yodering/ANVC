/**
 * Extracts file reads and writes from shell command text.
 *
 * An agent that edits through the shell is invisible to a PostToolUse matcher
 * on Read/Edit/Write: it never calls those tools. On this project most file
 * work is `cat > f <<EOF`, `sed -i`, or inline python doing `open(p,'w')`, so
 * without this the overlap metric would cover a minority of real activity.
 *
 * Heuristic by construction. It errs toward missing a path rather than
 * inventing one, because a fabricated read would corrupt the overlap number
 * that justifies the whole measurement.
 */
interface ShellPath { path: string; kind: "read" | "write" }

/** Strip quotes an operand may carry. Returns null for anything non-literal. */
function literal(token: string | undefined): string | null {
  if (!token) return null;
  const value = token.replace(/^['"]|['"]$/g, "");
  // Variables, globs, substitutions and process substitution are not literal
  // paths; guessing at them is how a fabricated path enters the dataset.
  if (!value || /[$*?`]/.test(value)) return null;
  if (value === "/dev/null" || value.startsWith("-")) return null;
  // Reject anything that is not plausibly a path. Validating extraction against
  // disk showed 23 of 33 claimed writes were fragments like "=", "0" and "+%s)":
  // shell syntax caught by a permissive matcher. A fabricated path corrupts the
  // overlap number this exists to measure, so the bar is deliberately high.
  if (/[=(){}!,;]|^\d+$/.test(value)) return null;
  // Require a path separator or a file extension: a bare word is far more often
  // a subcommand, flag value or pattern than a file. On Windows a backslash is
  // one; elsewhere it's an escape.
  if (!SEPARATOR.test(value) && !/^[\w.-]+\.[a-z0-9]{1,8}$/i.test(value)) return null;
  if (value.length > 4096) return null;
  return value;
}

// Claude Code runs its shell commands in Git Bash on Windows, where a
// backslash at the end of a word escapes what follows (build\ output) or the
// line break, so only one with more of the word after it separates folders.
// ponytail: words are still split at an escaped space there, so in
// notes\ 2024.md the 2024.md counts as a read; honour \ escapes for Git Bash
// if records from Windows show it.
const SEPARATOR = process.platform === "win32" ? /\/|\\(?!$)/ : /\//;

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "grep", "rg", "wc", "diff", "md5sum", "sha256sum", "jq", "sort", "uniq"]);
const WRITE_COMMANDS = new Set(["touch", "mkdir", "rm", "cp", "mv", "tee", "shred"]);

export function shellPaths(command: string): ShellPath[] {
  const found = new Map<string, "read" | "write">();
  const add = (path: string | null, kind: "read" | "write") => {
    if (!path) return;
    // A write outranks a read: `cat f > g` reads f and writes g, and a path
    // doing both in one command is a write for overlap purposes.
    if (kind === "write" || !found.has(path)) found.set(path, kind);
  };

  // Redirections: > f, >> f, but not 2> or >&1.
  for (const match of command.matchAll(/(?<![0-9&])>>?\s*(['"]?[^\s;|&()'"]+['"]?)/g)) add(literal(match[1]), "write");
  // Input redirection, excluding heredocs (<<), herestrings (<<<) and process
  // substitution (< <(...)), none of which name a file to attribute.
  for (const match of command.matchAll(/(?<!<)<(?!<)\s*(['"]?[^\s;|&()'"]+['"]?)/g)) add(literal(match[1]), "read");

  // sed -i FILE, with or without a script operand.
  for (const match of command.matchAll(/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\S*\s+)(?:(?:-e\s+)?(['"]).*?\1\s+)?(\S+)/g)) add(literal(match[2]), "write");

  // Inline python writing or reading a literal path: open('p','w').
  for (const match of command.matchAll(/open\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])([rwa])[^'"]*\3)?/g)) {
    const mode = match[4] ?? "r";
    add(literal(match[2]), mode === "r" ? "read" : "write");
  }

  // Simple command heads, including after a pipe or &&. Redirections and
  // heredoc markers are stripped first: without that, `cat > f` reads ">".
  for (const segment of command.split(/[;|]|&&|\|\||\n/)) {
    const bare = segment
      .replace(/<<-?\s*(['"]?)\w+\1/g, " ")
      .replace(/[0-9&]?>>?\s*[^\s;|&()]*/g, " ")
      .replace(/<\s*\([^)]*\)/g, " ")
      .replace(/(?<!<)<(?!<)\s*[^\s;|&()]*/g, " ");
    const tokens = bare.trim().split(/\s+/);
    let head = tokens[0];
    let rest = tokens.slice(1);
    // Skip a leading `cd X &&`-style prefix already split above; handle sudo/env.
    while (head && ["sudo", "env", "time", "nohup"].includes(head)) { head = rest[0]; rest = rest.slice(1); }
    if (!head) continue;
    const name = head.split("/").pop()!;
    const operands = rest.filter((t) => !t.startsWith("-"));
    // grep-family commands take a pattern first; treating it as a path would
    // invent a file that was never read.
    const patternFirst = name === "grep" || name === "rg";
    if (READ_COMMANDS.has(name)) {
      for (const operand of patternFirst ? operands.slice(1) : operands) add(literal(operand), "read");
    }
    else if (WRITE_COMMANDS.has(name)) {
      // cp/mv read the source and write the destination.
      if ((name === "cp" || name === "mv") && operands.length >= 2) {
        add(literal(operands[0]), "read");
        add(literal(operands.at(-1)), "write");
      } else for (const operand of operands) add(literal(operand), "write");
    }
  }

  return [...found].map(([path, kind]) => ({ path, kind }));
}
