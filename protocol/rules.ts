/**
 * Writing rules: for each kind of text a project writes, which files it
 * covers and where its rules are written.
 *
 * Commit messages, UI text, the README and a paper each follow different
 * rules, and an agent loses them at compaction: the person asked twice in one
 * session for AGENTS.md's writing rules to be recited. A rule set points at
 * the section of a file that holds its rules, usually a heading in AGENTS.md,
 * so the text keeps one home and editing that file changes what agents are
 * given. Inline text is for rules written nowhere else.
 *
 * Rule sets are records, versioned the way results are: a change or a
 * removal is a new record naming the rule set with `of`, and the latest one
 * wins. A fetched record is whoever-can-push's: it can add a rule set, shown
 * quoted with where it came from, and change only rule sets fetched too.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defaultTier, readRecords, RULE_FILE, tierOf, type CheckpointRecord, type Tier } from "./record";
import { fit, QUOTED, remoteOf } from "./query";
import { flag } from "./args";
import { below, realInside } from "./rawlog";
import { appendKept, type Actor } from "./results";

/** What `applies` says for commit messages, which have no file to match. */
export const COMMIT = "commit";

export interface RuleSet {
  /** The id of the record that added it; changes and removals name this. */
  id: string;
  name: string;
  applies: string[];
  source: { path: string; heading?: string } | null;
  text: string | null;
  /** When it was added or last changed, and by whom: an agent's name, or "person". */
  ts: string;
  by: string;
  /** The remote it was fetched from, or null when it was written here. */
  remote: string | null;
  tier: Tier;
}

type Rule = NonNullable<CheckpointRecord["rule"]>;
const shape = (x: Rule) => ({ name: x.name, applies: x.applies ?? [], source: x.source ?? null, text: x.text ?? null });

/** Every rule set now in force, by name. */
export function listRules(repo: string): RuleSet[] {
  const sets = new Map<string, RuleSet>();
  const changes: Array<{ r: CheckpointRecord; remote: string | null }> = [];
  for (const [ref, r] of readRecords(repo)) {
    if (!r.rule) continue;
    const remote = remoteOf(ref);
    if (r.rule.of) changes.push({ r, remote });
    else sets.set(r.id, { id: r.id, ...shape(r.rule), ts: r.ts, by: r.session.agent, remote, tier: tierOf(ref) });
  }
  changes.sort((a, b) => a.r.ts.localeCompare(b.r.ts));
  for (const { r, remote } of changes) {
    const set = sets.get(r.rule!.of!);
    if (!set || (remote && !set.remote)) continue;
    if (r.rule!.removed) sets.delete(set.id);
    else Object.assign(set, shape(r.rule!), { ts: r.ts, by: r.session.agent });
  }
  return [...sets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a rule set covers a repository-relative path, or `commit`. */
export function covers(set: RuleSet, target: string): boolean {
  const path = target.replace(/^\.\//, "");
  return set.applies.some((a) => path === COMMIT ? a === COMMIT : a !== COMMIT && new Bun.Glob(a).match(path));
}

/** Where a rule set's text is, as the page shows it: "AGENTS.md › Commit messages". */
const where = (set: RuleSet): string =>
  set.source ? `${set.source.path}${set.source.heading ? ` › ${set.source.heading}` : ""}` : "kept in ANVC";

// ------------------------------------------------------------------ the text

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const bare = (heading: string) => heading.replace(/^#+\s*/, "").trim().toLowerCase();

/**
 * The section under `heading`, up to the next heading of the same or a higher
 * level, or null when no heading says that. Headings inside fenced code are
 * code. Without a heading, the whole text.
 */
export function section(markdown: string, heading?: string): string | null {
  if (!heading) return markdown.trim();
  const want = bare(heading);
  const out: string[] = [];
  let fence: string | null = null;
  let level = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    let h: RegExpExecArray | null = null;
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? null : marker;
    else if (!fence) h = HEADING.exec(line);
    if (!level) {
      if (h && bare(h[2]!) === want) level = h[1]!.length;
      continue;
    }
    if (h && h[1]!.length <= level) break;
    out.push(line);
  }
  return level ? out.join("\n").trim() : null;
}

/** A rule set's text now, or what's missing, said plainly. */
export function ruleText(repo: string, set: RuleSet): { text: string } | { missing: string } {
  if (set.text !== null) return { text: set.text };
  const { path, heading } = set.source!;
  const real = realInside(repo, path);
  let body: string;
  try {
    if (!real || statSync(real).size > 1024 * 1024) throw new Error();
    body = readFileSync(real, "utf8");
  } catch { return { missing: `There's no ${path} in this repository.` }; }
  const text = section(body, heading);
  return text === null ? { missing: `${path} has no heading "${heading}".` } : { text };
}

// ------------------------------------------------------------ for the agent

/** Whether a shell command makes a commit: `git commit`, `git -C dir commit`. */
export const isCommit = (command: string): boolean =>
  /(^|[\s;&|(])git(\s+-[cC]\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+commit\b/.test(command);

/**
 * The list an agent gets when a session starts: each rule set's name, what
 * it covers and where its text is. Short, so it fits the briefing; the text
 * comes when it's needed.
 */
function rulesIndex(repo: string): string | null {
  const sets = listRules(repo);
  if (!sets.length) return null;
  const head = "anvc: this repository keeps writing rules for these kinds of text. Read a rule set before writing what it covers: "
    + "open it where it's kept, or call anvc_rules with `for` set to the file's path, or to commit.";
  // 1,200 characters in all, with room kept for the line that says how many more.
  const lines = fit(sets.map((set) => {
    const got = set.text === null ? ruleText(repo, set) : null;
    return `- ${set.remote ? `"${set.name}" (from ${set.remote})` : set.name}: ${set.applies.join(", ")} · ${where(set)}${
      got && "missing" in got ? ", which isn't there now" : ""}`;
  }), 1_200 - head.length - 59);
  const left = sets.length - lines.length;
  return [head, ...lines, ...(left ? [`- and ${left} more; anvc_rules lists them all`] : []), ...(sets.some((s) => s.remote) ? [QUOTED] : [])].join("\n");
}

/** One rule set's text for the agent, cut at a line past `max` characters. Fetched text is quoted. */
function ruleBlock(repo: string, set: RuleSet, max = 6_000): string {
  const head = `${set.remote ? `"${set.name}", fetched from ${set.remote}` : set.name} (${set.applies.join(", ")}; ${where(set)})`;
  const got = ruleText(repo, set);
  if ("missing" in got) return `${head}: ${got.missing}`;
  let text = set.remote ? got.text.split("\n").map((l) => `> ${l}`).join("\n") : got.text;
  if (text.length > max) {
    const cut = text.lastIndexOf("\n", max);
    text = `${text.slice(0, cut > 0 ? cut : max)}\n[Cut at ${max.toLocaleString("en")} characters; the rest is in ${where(set)}.]`;
  }
  return `${head}:\n${text}`;
}

/** The text of every rule set covering `target`, or null when none does. */
function rulesFor(repo: string, target: string): string | null {
  const hits = listRules(repo).filter((s) => covers(s, target));
  if (!hits.length) return null;
  return [...hits.map((s) => ruleBlock(repo, s)), ...(hits.some((s) => s.remote) ? [QUOTED] : [])].join("\n\n");
}

interface Seen { has: (key: string) => boolean; add: (key: string) => void }

/**
 * What the injection hook says about writing rules, once a session each:
 * the index when a session or subagent starts (again after compaction, which
 * forgets what was said), and a rule set's text the first time the agent is
 * about to write what it covers. Null when there's nothing new to say.
 */
export function rulesContext(repo: string, event: string, target: string | null, seen: Seen): string | null {
  const budget = 7_000;
  if (event === "SessionStart" || event === "SubagentStart") {
    if (seen.has("@rules")) return null;
    const index = rulesIndex(repo);
    if (index) seen.add("@rules");
    return index;
  }
  if (!target) return null;
  const fresh = listRules(repo).filter((s) => covers(s, target) && !seen.has(`@rule:${s.id}`));
  if (!fresh.length) return null;
  const head = target === COMMIT
    ? "anvc: this repository's writing rules for commit messages are below. If this commit's message doesn't follow them, amend it."
    : `anvc: this repository's writing rules for ${target} are below.`;
  const blocks: string[] = [];
  let size = head.length + QUOTED.length;
  let quoted = false;
  for (const set of fresh) {
    const block = ruleBlock(repo, set, Math.max(500, budget - size - 300));
    // One that doesn't fit after the first isn't claimed, so it's said next time.
    if (blocks.length && size + block.length + 2 > budget) break;
    blocks.push(block);
    size += block.length + 2;
    quoted ||= Boolean(set.remote);
    seen.add(`@rule:${set.id}`);
  }
  if (!blocks.length) return null;
  return [head, ...blocks, ...(quoted ? [QUOTED] : [])].join("\n\n");
}

// ------------------------------------------------------------------ writing

interface RuleInput {
  name: string;
  applies: string[];
  source?: { path: string; heading?: string };
  text?: string;
}

/** "AGENTS.md#Commit messages" as a source; a path alone is the whole file. */
export function parseFrom(repo: string, from: string): { path: string; heading?: string } {
  const at = from.indexOf("#");
  const file = (at < 0 ? from : from.slice(0, at)).trim();
  const heading = at < 0 ? "" : from.slice(at + 1).replace(/^#+\s*/, "").trim();
  if (!file) throw new Error("Name the file its rules are in, or write them out.");
  const path = below(repo, resolve(repo, file));
  if (!path) throw new Error(`${file} isn't inside this repository.`);
  return { path, ...(heading ? { heading } : {}) };
}

/** "README.md, docs/**\/*.md" as a list, with "./" dropped. */
export const parseApplies = (applies: string | string[]): string[] =>
  [...new Set((Array.isArray(applies) ? applies : applies.split(",")).map((a) => String(a).trim().replace(/^\.\//, "")).filter(Boolean))];

/** The rule as it's stored, or an error a person can act on (the envelope's own are for records). */
function clean(input: RuleInput): Rule {
  const applies = parseApplies(input.applies);
  if (!input.name.trim()) throw new Error("Give the rule set a name.");
  if (!applies.length) throw new Error("Say what it applies to: file globs, or commit.");
  if (input.text === undefined && !input.source?.path) throw new Error("Name the file its rules are in, or write them out.");
  if (input.source && !RULE_FILE.test(input.source.path)) throw new Error(`Rules are read from a Markdown or text file, and ${input.source.path} isn't one.`);
  return { name: input.name.trim(), applies, ...(input.text !== undefined ? { text: input.text.trim() } : { source: input.source }) };
}

/** Adds a rule set. Returns its id. */
export function addRule(repo: string, input: RuleInput, actor: Actor, why?: string): string {
  const rule = clean(input);
  return appendKept(repo, { rule }, `Writing rules: ${rule.name}`, why, actor, defaultTier(repo)).id;
}

function find(repo: string, id: string): RuleSet {
  const set = listRules(repo).find((s) => s.id === id);
  if (!set) throw new Error(`no rule set ${id}; anvc rules lists them with their ids`);
  return set;
}

/** Changes a rule set: what isn't given stays as it was. A new source replaces the text, and the other way round. */
export function changeRule(repo: string, id: string, change: Partial<RuleInput>, actor: Actor, why?: string): RuleSet {
  const set = find(repo, id);
  const source = change.text !== undefined ? undefined : change.source ?? set.source ?? undefined;
  const rule = clean({
    name: change.name ?? set.name, applies: change.applies ?? set.applies,
    ...(source ? { source } : { text: change.text ?? set.text ?? "" }),
  });
  appendKept(repo, { rule: { ...rule, of: id } }, `Changed writing rules: ${rule.name}`, why, actor, set.tier);
  return find(repo, id);
}

/** Removes a rule set. The records stay; it stops being shown or given to agents. */
export function removeRule(repo: string, id: string, actor: Actor, why?: string): RuleSet {
  const set = find(repo, id);
  appendKept(repo, { rule: { name: set.name, of: id, removed: true } }, `Removed writing rules: ${set.name}`, why, actor, set.tier);
  return set;
}

// ------------------------------------------------------ MCP tools and CLI

/** One line per rule set, for the tool and the command line. */
function listText(repo: string, sets = listRules(repo)): string {
  if (!sets.length) return "No writing rules here yet. Add a rule set with anvc_rule (or anvc rule add), pointing at the file and heading where the rules are written.";
  return sets.map((s) => {
    const got = ruleText(repo, s);
    return `- ${s.remote ? `"${s.name}" (from ${s.remote})` : s.name} · id: ${s.id}\n  applies to: ${s.applies.join(", ")}\n  text: ${
      where(s)}${"missing" in got ? ` (${got.missing})` : ""}`;
  }).join("\n");
}

export const RULE_TOOLS = [
  {
    name: "anvc_rules",
    description:
      "The writing rules this repository keeps for each kind of text: commit messages, UI text, the README, a paper. "
      + "With `for` set to a file path, or to commit for a commit message, you get the text of every rule set that covers it. "
      + "Call it before writing text of a kind that has rules, and again after your context is compacted.",
    inputSchema: {
      type: "object",
      properties: { for: { type: "string", description: "A repository-relative path such as README.md, or commit." } },
    },
  },
  {
    name: "anvc_rule",
    description:
      "Add, change or remove a rule set: its name, what it covers, and where its rules are written. "
      + "Point at the file and heading where the rules already are (AGENTS.md, Commit messages) instead of copying them; use text only for rules written nowhere else.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "change", "remove"] },
        id: { type: "string", description: "For change and remove: the rule set's id, from anvc_rules." },
        name: { type: "string", description: "The kind of text, as someone would say it: \"Commit messages\"." },
        applies: { type: "array", items: { type: "string" }, description: "File globs such as README.md or docs/**/*.md, or commit for commit messages." },
        source: {
          type: "object",
          description: "Where the rules are written: a repository-relative Markdown or text file, and the heading of their section. Without a heading, the whole file.",
          properties: { path: { type: "string" }, heading: { type: "string" } },
          required: ["path"],
        },
        text: { type: "string", description: "The rules themselves, when they aren't written in a file." },
        why: { type: "string", description: "Why you're adding, changing or removing it." },
      },
      required: ["action"],
    },
  },
];

/** Answers anvc_rules and anvc_rule. */
export function ruleTool(repo: string, name: string, args: Record<string, unknown>, actor: Actor): string {
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);
  if (name === "anvc_rules") {
    const target = str(args.for)?.trim();
    if (!target) return listText(repo);
    const path = target === COMMIT ? COMMIT : below(repo, resolve(repo, target)) ?? target;
    return rulesFor(repo, path) ?? `No writing rules here cover ${path === COMMIT ? "commit messages" : path}.`;
  }
  const why = str(args.why);
  const source = args.source && typeof args.source === "object" ? args.source as { path?: unknown; heading?: unknown } : null;
  const input: Partial<RuleInput> = {
    ...(str(args.name) ? { name: str(args.name) } : {}),
    ...(Array.isArray(args.applies) || str(args.applies) ? { applies: parseApplies(args.applies as string | string[]) } : {}),
    ...(source && str(source.path) ? { source: parseFrom(repo, `${String(source.path)}${str(source.heading) ? `#${String(source.heading)}` : ""}`) } : {}),
    ...(str(args.text) ? { text: str(args.text) } : {}),
  };
  const id = str(args.id);
  if (args.action === "add") {
    if (!input.name || !input.applies?.length) return "A rule set needs a name and what it applies to.";
    const added = addRule(repo, input as RuleInput, actor, why);
    return `Added:\n${listText(repo, listRules(repo).filter((s) => s.id === added))}`;
  }
  if (!id) return "Give the rule set's id; anvc_rules lists them.";
  if (args.action === "change") {
    const set = changeRule(repo, id, input, actor, why);
    return `Changed "${set.name}"\n${listText(repo, [set])}`;
  }
  if (args.action === "remove") return `Removed "${removeRule(repo, id, actor, why).name}". Its records stay; it's no longer shown.`;
  return "action is add, change or remove.";
}

const USAGE = `usage: anvc rule add "<name>" --applies "<glob>,<glob>" --from "<file>#<heading>"
       anvc rule add "<name>" --applies commit --text "<rules>"
       anvc rule change <id> [--name "<name>"] [--applies "..."] [--from "..." | --text "..."]
       anvc rule remove <id>`;

/** `anvc rules` and `anvc rule`. Returns the exit code. */
export function ruleCommand(repo: string, command: string, positional: string[], argv: string[]): number {
  if (command === "rules") {
    console.log(ruleTool(repo, "anvc_rules", { for: flag(argv, "for") }, { kind: "person" }));
    return 0;
  }
  const [verb, arg] = positional;
  const from = flag(argv, "from");
  const change: Partial<RuleInput> = {
    ...(flag(argv, "name") ? { name: flag(argv, "name") } : {}),
    ...(flag(argv, "applies") ? { applies: parseApplies(flag(argv, "applies")!) } : {}),
    ...(from ? { source: parseFrom(repo, from) } : {}),
    ...(flag(argv, "text") ? { text: flag(argv, "text") } : {}),
  };
  const why = flag(argv, "why");
  const person: Actor = { kind: "person" };
  try {
    if (verb === "add" && arg && change.applies?.length && (from || change.text)) {
      const id = addRule(repo, { ...change, name: arg } as RuleInput, person, why);
      console.log(`Added "${arg}" · id: ${id}`);
      return 0;
    }
    if (verb === "change" && arg && Object.keys(change).length) {
      console.log(`Changed "${changeRule(repo, arg, change, person, why).name}".`);
      return 0;
    }
    if (verb === "remove" && arg) {
      console.log(`Removed "${removeRule(repo, arg, person, why).name}".`);
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.error(USAGE);
  return 2;
}
