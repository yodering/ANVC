/**
 * The hooks ANVC runs in each agent, and reading and merging agents' hook
 * files. Setup in one repository, setup across every repository and the
 * plugin build all read the hooks from here, so the ways of installing ANVC
 * cannot drift apart.
 */
import { existsSync, readFileSync } from "node:fs";
import { has } from "../protocol/args";
import { writeJson } from "../protocol/rawlog";

type HookList = Record<string, Array<{ matcher?: string; command: string }>>;
type Json = Record<string, unknown>;

export { installedAgents } from "../protocol/agents";

/** A JSON settings file, or {} if there is none. Exits rather than overwrite a corrupt one. */
export function readJsonOrExit(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch {
    // Refuse rather than clobber: the file is the person's to fix, and
    // overwriting it would take their other hooks with it.
    console.error(`✗ ${file} is not valid JSON; fix or move it, then re-run`);
    process.exit(2);
  }
}

export { writeJson };

/**
 * A dry run lists each change as "- where: what" instead of making it. The
 * Folders page reads that list, so what it shows is what setup does. Setup's
 * other lines say what was done, so a dry run leaves them out. `short` is how
 * a file is named in the list.
 */
export function planner(argv: string[], short = (file: string) => file) {
  const dry = has(argv, "dry-run");
  let planned = 0;
  const plan = (where: string, what: string) => { planned++; console.log(`- ${where}: ${what}`); };
  return {
    dry,
    say: (dry ? () => {} : console.log) as (...lines: unknown[]) => void,
    plan,
    /** Writes a settings file, or in a dry run lists it. A file left as it was is neither. */
    save(file: string, data: object, what: string): void {
      if (JSON.stringify(readJsonOrExit(file)) === JSON.stringify(data)) return;
      if (dry) plan(short(file), what);
      else writeJson(file, data);
    },
    /** Says so when a dry run found nothing to change. */
    done: () => { if (dry && !planned) console.log("Nothing to change."); },
  };
}

/**
 * A path in a hook command, in double quotes the way the plugin writes
 * "${CLAUDE_PLUGIN_ROOT}". Claude Code, Codex and Cursor each hand the command
 * to a shell, and unquoted, a folder named with a space or `$(...)` was split
 * or run. Only the folder is quoted, so ours() still finds the script.
 */
export const quoted = (path: string): string => `"${path.replace(/["$`\\]/g, "\\$&")}"`;

/** Which of our scripts a hook command runs, and for which event: ["capture.ts", "Stop"]. */
export function ours(command: string): [string, string] {
  const words = command.split(" ");
  const at = words.findIndex((w) => /emitters\/claude-code\/\w+\.ts$/.test(w));
  return at < 0 ? ["", ""] : [words[at]!.replace(/^.*\//, ""), words[at + 1] ?? ""];
}

/** Whether a hook entry, in any agent's layout, is one of ANVC's. */
export const isOurs = (entry: unknown): boolean => /emitters\/claude-code\/(capture|inject|stop)\.ts/.test(JSON.stringify(entry));

/**
 * Merges hooks into Claude Code's or Codex's layout: events holding
 * `{ matcher, hooks: [{ type, command }] }`. Returns how many were added or
 * changed.
 */
export function mergeHooks(settings: Record<string, unknown>, wanted: HookList): number {
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  let installed = 0;
  for (const [event, entries] of Object.entries(wanted)) {
    const list = (hooks[event] ??= []) as Array<Record<string, unknown>>;
    for (const entry of entries) {
      // Someone else's hook on the same event is left alone; only ours is
      // replaced. Matched on the script and the event together: capture and
      // inject both run on UserPromptSubmit, so matching on the event name
      // alone made the second overwrite the first, silently turning capture
      // off on the one event that starts every turn.
      // Compared on the commands themselves: in ANVC's own checkout the path
      // is "$CLAUDE_PROJECT_DIR" in quotes, which JSON escapes, so searching
      // the serialised hook never matched and every hook was added twice.
      const [script, forEvent] = ours(entry.command);
      const same = (c: { command?: unknown }) => typeof c.command === "string" && ours(c.command)[0] === script && ours(c.command)[1] === forEvent;
      const mine = list.findIndex((h) => ((h.hooks ?? []) as Array<{ command?: string }>).some(same));
      const command = { type: "command", command: entry.command };
      const node = { ...(entry.matcher ? { matcher: entry.matcher } : {}), hooks: [command] };
      const at = list[mine];
      const commands = (at?.hooks ?? []) as Array<Record<string, unknown>>;
      const i = commands.findIndex(same);
      // A person may have put their own commands in the same entry as ours,
      // and replacing the whole entry deleted them. Only ours changes, and
      // under a new matcher, which would apply to theirs too, ours moves to an
      // entry of its own.
      if (!at) {
        list.push(node);
      } else if (commands.length === 1) {
        if (JSON.stringify(at) === JSON.stringify(node)) continue;
        list[mine] = node;
      } else if (at.matcher === entry.matcher) {
        if (JSON.stringify(commands[i]) === JSON.stringify(command)) continue;
        commands[i] = command;
      } else {
        commands.splice(i, 1);
        list.push(node);
      }
      installed++;
    }
  }
  return installed;
}

/** Merges hooks into Cursor's flat layout: `{ version, hooks: { event: [{ command }] } }`. */
export function mergeCursorHooks(config: Record<string, unknown>, wanted: Record<string, string[]>): number {
  config.version ??= 1;
  const hooks = (config.hooks ??= {}) as Record<string, Array<{ command: string }>>;
  let installed = 0;
  for (const [event, commands] of Object.entries(wanted)) {
    const list = (hooks[event] ??= []);
    for (const command of commands) {
      // Ours are recognised by script and event; anyone else's are left alone.
      const [script, forEvent] = ours(command);
      const mine = list.findIndex((h) => typeof h.command === "string" && ours(h.command)[0] === script && ours(h.command)[1] === forEvent);
      if (mine >= 0 && list[mine]!.command === command) continue;
      if (mine >= 0) list[mine] = { command };
      else list.push({ command });
      installed++;
    }
  }
  return installed;
}

/**
 * Takes every ANVC hook out of a settings object, in either layout. Returns
 * how many. In Claude Code's and Codex's layout an entry can hold other
 * commands next to ours; only ours go, and the entry only when it's empty.
 */
export function removeOurs(settings: Record<string, unknown>): number {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return 0;
  let removed = 0;
  for (const [event, list] of Object.entries(hooks)) {
    const kept: unknown[] = [];
    for (const h of list) {
      const commands = (h as { hooks?: unknown }).hooks;
      if (!Array.isArray(commands)) {
        if (isOurs(h)) removed++; else kept.push(h);
        continue;
      }
      const theirs = commands.filter((c) => !isOurs(c));
      removed += commands.length - theirs.length;
      if (theirs.length === commands.length) kept.push(h);
      else if (theirs.length) kept.push({ ...(h as object), hooks: theirs });
    }
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  return removed;
}

/** Takes the ANVC plugin and its marketplace out of Claude Code settings. True if either was there. */
export function dropPlugin(data: Json): boolean {
  const enabled = data.enabledPlugins as Json | undefined;
  const markets = data.extraKnownMarketplaces as Json | undefined;
  const had = Boolean(enabled && "anvc@anvc" in enabled) || Boolean(markets && "anvc" in markets);
  if (enabled) { delete enabled["anvc@anvc"]; if (!Object.keys(enabled).length) delete data.enabledPlugins; }
  if (markets) { delete markets.anvc; if (!Object.keys(markets).length) delete data.extraKnownMarketplaces; }
  return had;
}

/** Takes ANVC's server out of an `mcpServers` map. True if it was there. */
export function dropServer(data: Json): boolean {
  const list = data.mcpServers as Json | undefined;
  if (!list || !("anvc" in list)) return false;
  delete list.anvc;
  return true;
}

/** Claude Code's hooks, given each script's command up to the event name, e.g. `bun /path/capture.ts`. */
export function claudeHooks({ capture, inject, stop }: { capture: string; inject: string; stop: string }): HookList {
  return {
    // `Task` is here because delegation was invisible without it. Measured on
    // this repository in one day: 902 captured events under a single session
    // id while seven subagents ran and edited files, and zero Task events,
    // because the matcher did not list it. An agent that hands the actual
    // editing to a worker left no trace of having done so. WebFetch and
    // WebSearch are here for the pages and searches kept as sources
    // (protocol/sources.ts).
    PostToolUse: [
      { matcher: "Read|Edit|Write|NotebookEdit|Bash|Task|WebFetch|WebSearch", command: `${capture} PostToolUse` },
    ],
    // Claude Code sends a failed tool call here and never to PostToolUse, so
    // this is where failures are captured at all, and where stuck detection
    // speaks: a failure whose error was seen before, or one that has
    // happened twice already this session. Verified live on 2.1.283 that
    // context added here reaches the model.
    PostToolUseFailure: [
      { matcher: "Bash", command: `${capture} PostToolUseFailure` },
      { matcher: "Bash", command: `${inject} PostToolUseFailure` },
    ],
    // Both run on this event: capture records what happened, inject answers
    // with what is already known. It is also the only event verified to carry
    // context back to the model — see the note in inject.ts.
    UserPromptSubmit: [{ command: `${capture} UserPromptSubmit` }, { command: `${inject} UserPromptSubmit` }],
    // Asks once for a checkpoint when the session edited files and recorded
    // nothing. Sonnet 5 skipped it on the yodermon trial with the instruction
    // in AGENTS.md; see stop.ts.
    Stop: [{ command: `${capture} Stop` }, { command: `${stop} Stop` }],
    // The final private copy of the session, before the agent's own copy
    // starts counting down to deletion. Captured too, so Status knows the
    // session is over.
    SessionEnd: [{ command: `${capture} SessionEnd` }, { command: `${stop} SessionEnd` }],
    // Bash for a git commit, whose message the writing rules for commits
    // cover (protocol/rules.ts); inject.ts exits at once on any other command.
    PreToolUse: [{ matcher: "Read|Edit|Write|NotebookEdit|Bash", command: `${inject} PreToolUse` }],
    SessionStart: [{ matcher: "startup|resume|clear|compact|fork", command: `${inject} SessionStart` }],
    // A subagent starts with a fresh, isolated context window and sees nothing
    // that was injected into its parent — so the agent doing the actual
    // editing was the one agent flying blind. No matcher: every kind of
    // subagent edits files.
    // Captured on start and stop, so Status can say which subagents are
    // still running and what each was asked to do (protocol/status.ts).
    SubagentStart: [{ command: `${capture} SubagentStart` }, { command: `${inject} SubagentStart` }],
    SubagentStop: [{ command: `${capture} SubagentStop` }],
  };
}

/** Codex reads Claude Code's layout and event names; the scripts are told it's Codex. */
export function codexHooks(here: string): HookList {
  const run = (script: string, event: string) => `bun ${quoted(here)}/emitters/claude-code/${script}.ts ${event} --agent codex`;
  return {
    PostToolUse: [{ command: run("capture", "PostToolUse") }, { command: run("inject", "PostToolUse") }],
    UserPromptSubmit: [{ command: run("capture", "UserPromptSubmit") }, { command: run("inject", "UserPromptSubmit") }],
    Stop: [{ command: run("capture", "Stop") }, { command: run("stop", "Stop") }],
    SessionEnd: [{ command: run("capture", "SessionEnd") }, { command: run("stop", "SessionEnd") }],
    // Codex cannot add context here, so this only marks the compaction; the
    // account of the session goes out with the next prompt.
    PostCompact: [{ command: run("inject", "PostCompact") }],
    SessionStart: [{ command: run("inject", "SessionStart") }],
    SubagentStart: [{ command: run("inject", "SubagentStart") }],
  };
}

/** Cursor names its events differently and lists commands flat under each. */
export function cursorHooks(here: string): Record<string, string[]> {
  const run = (script: string, event: string) => `bun ${quoted(here)}/emitters/claude-code/${script}.ts ${event} --agent cursor`;
  return {
    sessionStart: [run("inject", "SessionStart")],
    beforeSubmitPrompt: [run("capture", "UserPromptSubmit"), run("inject", "UserPromptSubmit")],
    postToolUse: [run("capture", "PostToolUse")],
    // Cursor reports a failed tool call here rather than in postToolUse.
    postToolUseFailure: [run("capture", "PostToolUse"), run("inject", "PostToolUse")],
    subagentStart: [run("inject", "SubagentStart")],
    stop: [run("capture", "Stop"), run("stop", "Stop")],
    sessionEnd: [run("capture", "SessionEnd"), run("stop", "SessionEnd")],
    preCompact: [run("inject", "PreCompact")],
  };
}
