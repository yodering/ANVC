/**
 * Command-line flags, shared by the four entry points, and an MCP tool's
 * text arguments.
 *
 * There were four copies of this, and one had already lost the
 * `startsWith("--")` guard, so `anvc why --repo --capture x` silently took
 * `--capture` as the repository path.
 */

/** The value after `--name`, or `fallback` when absent. */
export function flag(argv: string[], name: string): string | undefined;
export function flag(argv: string[], name: string, fallback: string): string;
export function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  // A flag followed by another flag has no value; treating the next flag as one
  // is how a missing argument became a plausible-looking path.
  return value && !value.startsWith("--") ? value : fallback;
}

/** Whether `--name` was passed at all. */
export const has = (argv: string[], name: string): boolean => argv.includes(`--${name}`);

/**
 * Every bare argument, in order: a search term the user typed as several words.
 *
 * A word is bare when it is not a flag and not the value of one. The old
 * per-file copies used `argv.indexOf(a)`, which finds the *first* occurrence of
 * a repeated word and so misjudged whether it followed a flag.
 */
export function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // Skip this flag's value, so it is never mistaken for a bare word;
      // `--agent=codex` carries its own.
      if (!a.includes("=") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** An MCP tool's argument as trimmed text, or undefined when it's missing, blank or not text. */
export const textArg = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;

/** The first bare argument: a subcommand, a path, a URL. */
export const positional = (argv: string[]): string | undefined => positionals(argv)[0];

/** One word for a POSIX shell: as it is when that's safe, else in single quotes. */
export const shellWord = (w: string): string => /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;

/**
 * One word for cmd.exe and the Windows program it starts: as it is when
 * that's safe, else in double quotes, with the backslashes before a quote
 * doubled the way Windows programs read their arguments. cmd.exe reads the
 * line first and doesn't take a backslash as an escape, so every character it
 * treats specially, the quotes included, gets a caret: without one, the & in
 * "a & b" ended the command there. This is cross-spawn's escapeArgument.
 */
export const cmdWord = (w: string): string =>
  /^[\w@+=:,./\\-]+$/.test(w) ? w
    : `"${w.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`.replace(/[()[\]%!^"`<>&|;, *?]/g, "^$&");
