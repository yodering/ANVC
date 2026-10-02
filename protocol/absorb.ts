/**
 * Goals, sub-goals and writing rules, kept up to date from the sessions, for
 * the person to see.
 *
 * Goals and rules only appeared when someone asked for them: on a research
 * project with 27 records over four days of one clear aim, ANVC had no goals
 * and no rules, because nobody had stopped to add them. People don't want to.
 * So once a turn ends, at most every half hour, a small model reads what is
 * new since the last update (the person's prompts and the recorded attempts)
 * and changes the goals and rules to match. It runs outside the session,
 * through the agent's own command line (claude or codex), so the session
 * never sees it and nothing in it costs the session's context.
 *
 * It costs tokens on the person's plan, so it's off until they turn it on,
 * and the setting says what it costs.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { logActivity } from "./activity";
import { addGoal, allGoals, changeGoal, goalTree, type Goal } from "./goals";
import { marker } from "./localonly";
import { captureRows, lastDays, readJson, writeJson } from "./rawlog";
import { defaultTier, readRecords, type CheckpointRecord, GOAL_STATUSES, type GoalStatus } from "./record";
import type { Actor } from "./results";
import { addRule, changeRule, listRules } from "./rules";
import { gitOrNull } from "./git";
import { partMaps, withIndex, type PartMap } from "./query";
import { appendKept } from "./results";
import { stateHome } from "./version";

// ------------------------------------------------------------------ settings

export type AbsorbMode = "off" | "claude" | "codex";
export const ABSORB_MODES: Record<AbsorbMode, { label: string; what: string; tokens: string }> = {
  off: { label: "Off", what: "Goals, writing rules and the map change only when you or your agent change them.", tokens: "" },
  claude: { label: "Claude Haiku", what: "Claude Haiku updates goals, writing rules and the map after your agent's turns, through your claude login.", tokens: "About 3,500 tokens an update, at most one every 30 minutes, on your Claude plan" },
  codex: { label: "Codex", what: "A small Codex model updates goals, writing rules and the map after your agent's turns, through your codex login.", tokens: "About 16,000 tokens an update, at most one every 30 minutes, on your ChatGPT plan" },
};
export const DEFAULT_ABSORB_MODE: AbsorbMode = "off";
/** What it costs, measured, for every place that offers it. */
export const ABSORB_COST = "It uses your plan: with Claude Haiku, about 8,000 tokens for the first update and 3,500 for each one after, where one request from your agent in a long session sends about 300,000. Codex uses 16,000 to 20,000, most of them its own instructions.";

const everywhereFile = () => join(stateHome(), "absorb.json");
const projectFile = (repo: string) => marker(repo, "absorb.json");
const readMode = (file: string | null): AbsorbMode | null => {
  const mode = file ? readJson<{ mode?: unknown } | null>(file, null)?.mode : undefined;
  return typeof mode === "string" && Object.hasOwn(ABSORB_MODES, mode) ? mode as AbsorbMode : null;
};

/** This project's choice, else the one for every project, else off. */
export function absorbMode(repo: string | null): { mode: AbsorbMode; from: "project" | "everywhere" | "default" } {
  const project = repo ? readMode(projectFile(repo)) : null;
  if (project) return { mode: project, from: "project" };
  const everywhere = readMode(everywhereFile());
  if (everywhere) return { mode: everywhere, from: "everywhere" };
  return { mode: DEFAULT_ABSORB_MODE, from: "default" };
}

/** `repo` null sets it for every project. */
export function setAbsorbMode(repo: string | null, mode: AbsorbMode): void {
  if (!Object.hasOwn(ABSORB_MODES, mode)) throw new Error(`mode must be one of ${Object.keys(ABSORB_MODES).join(", ")}`);
  const file = repo ? projectFile(repo) : everywhereFile();
  if (!file) throw new Error("not a git repository");
  writeJson(file, { mode });
}

/** Drops the project's own choice, so it follows the one for every project. */
export function clearProjectAbsorbMode(repo: string): void {
  const file = projectFile(repo);
  if (file) rmSync(file, { force: true });
}

/** Everything the work log shows about it: the choice, what it costs, which commands are here, and the updates so far. */
export function absorbView(repo: string) {
  return {
    setting: absorbMode(repo), everywhere: absorbMode(null).mode, modes: ABSORB_MODES,
    available: { claude: Boolean(Bun.which("claude")), codex: Boolean(Bun.which("codex")) }, last: readCursor(repo),
  };
}

// ------------------------------------------------------------- what's new

/** Where the last update got to, and what it cost, kept beside the project's other settings. */
interface Cursor { since: string; ran: string; runs: number; tokens: number }
const cursorFile = (repo: string) => marker(repo, "absorbed.json");
export const readCursor = (repo: string): Cursor | null => { const f = cursorFile(repo); return f ? readJson<Cursor | null>(f, null) : null; };

/** At most this often, however many turns end. */
const EVERY_MS = 30 * 60_000;
/** What the model reads per update: prompts are cut, and only the newest fit. */
const PROMPT_CHARS = 600;
const MATERIAL_CHARS = 16_000;

export interface Material {
  prompts: Array<{ ts: string; session: string; text: string }>;
  attempts: Array<{ ts: string; session: string; status: string; goal: string; why: string }>;
  /** The newest moment read, which the next update starts after. */
  until: string;
}

const isAttempt = (r: CheckpointRecord) => !r.objective && !r.rule && !r.tool_note && !r.status_item && Boolean(r.intent?.goal);

/** The person's prompts and the recorded attempts since `since`, newest kept when there's too much. */
export function material(repo: string, since: string, captureRoot?: string): Material {
  const prompts = captureRows(repo, captureRoot, lastDays(30))
    .filter((r) => r.prompt && r.ts > since)
    .map((r) => ({ ts: r.ts, session: r.session_id ?? "", text: r.prompt!.replace(/\s+/g, " ").trim().slice(0, PROMPT_CHARS) }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const attempts = readRecords(repo).map(([, r]) => r)
    .filter((r) => isAttempt(r) && r.ts > since)
    .map((r) => ({ ts: r.ts, session: r.session.run_id, status: r.outcome.status, goal: r.intent.goal!.slice(0, 200), why: (r.intent.why ?? "").replace(/\s+/g, " ").slice(0, 300) }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const until = [...prompts, ...attempts].reduce((m, x) => (x.ts > m ? x.ts : m), since);
  // Newest first until the budget is spent, then back in order.
  let left = MATERIAL_CHARS;
  const keep = <T extends { text?: string; goal?: string; why?: string }>(list: T[]) => list.slice().reverse().filter((x) => {
    const size = (x.text ?? "").length + (x.goal ?? "").length + (x.why ?? "").length + 40;
    if (size > left) return false;
    left -= size;
    return true;
  }).reverse();
  return { attempts: keep(attempts), prompts: keep(prompts), until };
}

/** Whether a turn's end should start an update: it's on, the last one was long enough ago, and something is new. */
export function absorbDue(repo: string, now = Date.now(), captureRoot?: string): boolean {
  if (absorbMode(repo).mode === "off") return false;
  const cursor = readCursor(repo);
  if (cursor && now - Date.parse(cursor.ran) < EVERY_MS) return false;
  const m = material(repo, cursor?.since ?? "", captureRoot);
  return m.prompts.length + m.attempts.length > 0;
}

// ------------------------------------------------------------- the model

export const SYSTEM = `You keep a software or research project's goals and writing rules up to date for the person who runs it, from what happened in their agent sessions. Nobody else reads your answer: return one JSON object and nothing else.

{"goals": [{"id": "an existing goal's id to change it, or a short name of your own for a new goal", "title": "...", "parent": "the id of the goal it belongs under: an existing one, or the name you gave a new one", "status": "todo | doing | done | dropped", "why": "one sentence: what in the sessions shows it"}],
 "rules": [{"id": "an existing rule set's id, to change it", "name": "the kind of text, such as Replies to me or Commit messages", "applies": ["replies" or "commit" or file globs such as README.md or docs/**/*.md"], "text": "the rules, short, in the person's words"}],
 "map": [{"part": "a name a person would say, such as the search lanes", "does": "what it is for, in one or two plain sentences", "layer": "edge | core | store | tool | surface", "owns": ["folders ending in / or files, from the project's files below"], "reads": [{"part": "another part's exact name", "what": "two or three words for what it takes"}]}]}

Goals:
- A goal is what the person is trying to achieve in this project, such as "Decide whether a 21x21 coloring exists". A sub-goal is a line of work toward a goal, such as "Break the 44-cell skeleton" or "Write up the findings as a report"; when the person starts a new line of work, add it. A single command, fix or question is neither, and neither is how the work gets done: "Scale to 192 vCPUs on AWS", "Spawn sub-agents" and "Set up the cloud runner" are never goals.
- Use at most 3 goals and at most 6 sub-goals under each. Prefer changing an existing goal to adding a near-duplicate.
- Include a goal only when it's new or the sessions show a change: work started on it (doing), it was finished (done), it was given up or replaced (dropped), or a clearly better title. Leave out goals that didn't change.

Writing rules:
- A writing rule says how text should be worded or laid out: its length, tone, language, words to use or avoid, structure. It applies to a kind of text (replies to the person, commit messages, docs, papers, UI text) and is meant to hold beyond one message, such as "keep replies very short and simple".
- What to do is never a writing rule: which tools, machines, agents or steps to use, how to run or check the work. Leave all of that out.
- Keep one rule set per kind of text, named by that kind only: "Replies to me", "Commit messages", "README", "Paper". A new rule for a kind that has a set changes that set: give its id and its whole text, old rules and new.
- Include a rule set only when it's new or changed. Keep its text short.

The project map:
- A part is a piece of the project a person would name, such as "the search lanes" or "the cloud runner", and owns folders or files. Use at most 8 parts. Name each part's folders from the project's files below only.
- Layers: edge touches the outside world, core is the logic in the middle, store keeps data, tool is something run by hand, surface is what a person looks at.
- Include a part only when it's new or the sessions or files show it changed. To change one, give its exact name and all its fields. Leave the map out when nothing changed.

Never invent: everything must come from the sessions and files below. Never include secrets, keys, personal details or file contents. If nothing changed, return {"goals": [], "rules": [], "map": []}.`;

/**
 * The project's files as the model needs them to name a part's folders: each
 * top-level folder with its file count and a few names, then the files at the
 * top. Cut at 3,000 characters.
 */
/** The project's committed files: from HEAD, which a clone without a checkout has too. */
const projectFiles = (repo: string): string[] =>
  (gitOrNull(repo, ["ls-tree", "-r", "--name-only", "HEAD"]) ?? gitOrNull(repo, ["ls-files"]) ?? "").split("\n").filter(Boolean);

export function filesSummary(repo: string): string {
  const paths = projectFiles(repo);
  const dirs = new Map<string, string[]>();
  const top: string[] = [];
  for (const p of paths) {
    const at = p.indexOf("/");
    if (at < 0) top.push(p);
    else (dirs.get(p.slice(0, at + 1)) ?? dirs.set(p.slice(0, at + 1), []).get(p.slice(0, at + 1))!).push(p.slice(at + 1));
  }
  const lines = [...dirs].sort((a, b) => b[1].length - a[1].length)
    .map(([d, f]) => `- ${d} (${f.length} file${f.length === 1 ? "" : "s"}: ${f.slice(0, 5).join(", ")}${f.length > 5 ? ", …" : ""})`);
  if (top.length) lines.push(`- at the top: ${top.slice(0, 15).join(", ")}${top.length > 15 ? ", …" : ""}`);
  let out = "";
  for (const line of lines) { if (out.length + line.length > 3_000) break; out += `${line}\n`; }
  return out.trimEnd();
}

/** The update's input: what stands now, then what's new. */
export function brief(project: string, goals: Goal[], rules: ReturnType<typeof listRules>, m: Material, map: PartMap[] = [], files = ""): string {
  const goalLine = (g: Goal, depth: number): string[] =>
    [`${"  ".repeat(depth)}- id ${g.id} [${g.status}] ${g.title}`, ...g.subgoals.filter((s) => s.status !== "dropped").flatMap((s) => goalLine(s, depth + 1))];
  const live = goals.filter((g) => g.status !== "dropped");
  const dropped = allGoals(goals).filter((g) => g.status === "dropped").slice(-20);
  return [
    `Project: ${project}`,
    "",
    "Goals now:",
    ...(live.length ? live.flatMap((g) => goalLine(g, 0)) : ["(none yet)"]),
    ...(dropped.length ? ["", "Dropped, so never add these again:", ...dropped.map((g) => `- ${g.title}`)] : []),
    "",
    "Writing rules now:",
    ...(rules.length ? rules.map((r) => `- id ${r.id} ${r.name} (${r.applies.join(", ")}): ${r.text ?? `kept in ${r.source?.path}`}`.slice(0, 400)) : ["(none yet)"]),
    "",
    "The project map now:",
    ...(map.length ? map.map((p) => `- ${p.part}${p.layer ? ` [${p.layer}]` : ""}: ${p.does}${p.owns?.length ? ` (owns ${p.owns.join(", ")})` : ""}`.slice(0, 400)) : ["(no parts yet)"]),
    ...(files ? ["", "The project's files:", files] : []),
    "",
    "The person's messages since the last update, oldest first:",
    ...(m.prompts.length ? m.prompts.map((p) => `- (${p.ts.slice(0, 16).replace("T", " ")}) ${p.text}`) : ["(none)"]),
    "",
    "Attempts the agents recorded since the last update, oldest first:",
    ...(m.attempts.length ? m.attempts.map((a) => `- ${a.status}: ${a.goal}${a.why ? ` — ${a.why}` : ""}`) : ["(none)"]),
  ].join("\n");
}

/** Tokens only: on a subscription nobody pays per call, so a price would mislead. */
export interface ModelAnswer { text: string; tokens: number }
export type Runner = (system: string, input: string) => ModelAnswer;

/**
 * Claude Haiku through `claude -p`, in an empty folder outside any repository
 * so no project's hooks run, with every hook, tool and MCP server off and
 * Claude Code's own system prompt replaced by ours. Without the person's own
 * settings, their CLAUDE.md stays out too: it cost 640 tokens a call, and the
 * model took its rules for ones said in the session. Thinking is off: left to
 * Claude Code's default it wrote 7,192 tokens where the answer took 858.
 */
export const viaClaude: Runner = (system, input) => {
  const dir = mkdtempSync(join(tmpdir(), "anvc-absorb-"));
  try {
    const p = spawnSync("claude", ["-p", "--model", "haiku", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "project", "--settings", '{"disableAllHooks":true,"alwaysThinkingEnabled":false}',
      "--tools", "", "--system-prompt", system, "--output-format", "json"], { cwd: dir, input, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    if (p.status !== 0) throw new Error(`claude exited ${p.status}: ${(p.stderr || p.stdout || "").slice(0, 300)}`);
    const out = JSON.parse(p.stdout) as Array<Record<string, any>> | Record<string, any>;
    const result = (Array.isArray(out) ? out : [out]).find((m) => m.type === "result")!;
    const u = result.usage ?? {};
    return { text: String(result.result ?? ""), tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

/** A small Codex model through `codex exec`, read-only, outside any repository, keeping nothing. */
export const viaCodex: Runner = (system, input) => {
  const dir = mkdtempSync(join(tmpdir(), "anvc-absorb-"));
  try {
    const last = join(dir, "answer.txt");
    // A ChatGPT account's Codex refuses gpt-5-mini; Luna is its small model.
    const p = spawnSync("codex", ["exec", "-m", process.env.ANVC_ABSORB_CODEX_MODEL ?? "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--json", "-o", last, "-"],
      { cwd: dir, input: `${system}\n\n${input}`, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (p.status !== 0) throw new Error(`codex exited ${p.status}: ${(p.stderr || "").slice(-300)}`);
    let tokens = 0;
    for (const line of p.stdout.split("\n")) {
      try { const u = JSON.parse(line).usage; if (u) tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0); } catch { /* not an event */ }
    }
    return { text: existsSync(last) ? readFileSync(last, "utf8") : "", tokens };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// ------------------------------------------------------------- the answer

export interface Plan {
  goals: Array<{ id?: string; title: string; parent?: string; status: GoalStatus; why: string }>;
  rules: Array<{ id?: string; name: string; applies: string[]; text: string }>;
  map: Array<{ part: string; does: string; layer?: NonNullable<PartMap["layer"]>; owns: string[]; reads: Array<{ part: string; what: string }> }>;
}

const LAYERS = ["edge", "core", "store", "tool", "surface"] as const;

/** The model's JSON, with anything malformed left out rather than guessed at. */
export function parsePlan(text: string): Plan {
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let raw: any;
  try { raw = JSON.parse(body); } catch { return { goals: [], rules: [], map: [] }; }
  const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
  const goals = (Array.isArray(raw?.goals) ? raw.goals : []).flatMap((g: any) => {
    const title = str(g?.title, 200);
    const status = GOAL_STATUSES.includes(g?.status) ? g.status as GoalStatus : undefined;
    return title && status ? [{ id: str(g.id, 40), title, parent: str(g.parent, 200), status, why: str(g.why, 300) ?? "" }] : [];
  });
  const rules = (Array.isArray(raw?.rules) ? raw.rules : []).flatMap((r: any) => {
    const name = str(r?.name, 80);
    const text = str(r?.text, 2000);
    const applies = (Array.isArray(r?.applies) ? r.applies : []).map((a: unknown) => str(a, 120)).filter(Boolean) as string[];
    return name && text && applies.length ? [{ id: str(r.id, 40), name, applies, text }] : [];
  });
  const map = (Array.isArray(raw?.map) ? raw.map : []).flatMap((m: any) => {
    const part = str(m?.part, 80);
    const does = str(m?.does, 400);
    const owns = (Array.isArray(m?.owns) ? m.owns : []).map((o: unknown) => str(o, 200)).filter(Boolean) as string[];
    const reads = (Array.isArray(m?.reads) ? m.reads : []).flatMap((r: any) => {
      const p = str(r?.part, 80); const w = str(r?.what, 60);
      return p && w ? [{ part: p, what: w }] : [];
    });
    const layer = LAYERS.includes(m?.layer) ? m.layer as Plan["map"][number]["layer"] : undefined;
    return part && does ? [{ part, does, ...(layer ? { layer } : {}), owns, reads }] : [];
  });
  return { goals, rules, map };
}

/** At most this many new goals and rule sets per update, whatever the model says. */
const NEW_GOALS = 8;
const NEW_RULES = 3;

/** Applies the plan as `actor`. Returns the ids written and their titles. */
export function applyPlan(repo: string, plan: Plan, actor: Actor): { ids: string[]; titles: string[] } {
  const ids: string[] = [];
  const titles: string[] = [];
  const goals = () => allGoals(goalTree(repo));
  const byTitle = new Map<string, string>(goals().map((g) => [g.title.toLowerCase(), g.id]));
  // A model names a new goal with an id of its own making, and its sub-goals use that as parent.
  const local = new Map<string, string>();
  let added = 0;
  // A goal that names itself as parent is a top-level one, as one model answered.
  let pending = plan.goals.map((g) => (g.parent && g.parent === g.id ? { ...g, parent: undefined } : g));
  const parentOf = (g: Plan["goals"][number], known: Goal[]) =>
    !g.parent ? undefined : known.some((k) => k.id === g.parent) ? g.parent : local.get(g.parent) ?? byTitle.get(g.parent.toLowerCase());
  // In passes, so a sub-goal waits for the new goal it names, whatever the order.
  for (let pass = 0; pending.length && pass < 4; pass++) {
    const waiting: typeof pending = [];
    for (const g of pending) {
      const known = goals();
      const id = (g.id && known.some((k) => k.id === g.id) ? g.id : undefined) ?? byTitle.get(g.title.toLowerCase());
      try {
        if (id) {
          const before = known.find((k) => k.id === id)!;
          // What the person did last stands, and what was dropped stays dropped.
          if (before.versions.at(-1)?.by === "person" || before.status === "dropped") continue;
          const after = changeGoal(repo, id, { status: g.status, ...(g.id === id ? { title: g.title } : {}), why: g.why || "From the sessions." }, actor);
          if (after.status !== before.status || after.title !== before.title || after.proposal) { ids.push(id); titles.push(after.title); }
          continue;
        }
        const parent = parentOf(g, known);
        if (g.parent && !parent) { waiting.push(g); continue; }
        if (added >= NEW_GOALS) continue;
        const newId = addGoal(repo, { title: g.title, ...(parent ? { parent } : {}), status: g.status, why: g.why || "From the sessions." }, actor);
        byTitle.set(g.title.toLowerCase(), newId);
        if (g.id) local.set(g.id, newId);
        ids.push(newId); titles.push(g.title); added++;
      } catch { /* a goal that can't be written is left out; the next update sees the sessions again */ }
    }
    if (waiting.length === pending.length) break;
    pending = waiting;
  }
  const sets = listRules(repo);
  // Rule sets the person removed, by name and by what they covered, so they aren't added back.
  const removed = readRecords(repo).map(([, r]) => r.rule).filter((x) => x?.removed);
  const removedNames = new Set(removed.map((x) => x!.name.toLowerCase()));
  let newRules = 0;
  for (const r of plan.rules) {
    const kind = (x: { applies: string[] }) => [...x.applies].sort().join(",");
    const same = sets.find((s) => s.id === r.id) ?? sets.find((s) => s.name.toLowerCase() === r.name.toLowerCase())
      ?? sets.find((s) => s.text !== null && kind(s) === kind(r));
    try {
      if (same) {
        if (same.text === null || same.text === r.text || same.by === "person") continue;
        changeRule(repo, same.id, { text: r.text, applies: r.applies }, actor, "From the sessions.");
        ids.push(same.id); titles.push(`Writing rules: ${r.name}`);
        continue;
      }
      if (newRules >= NEW_RULES || removedNames.has(r.name.toLowerCase())) continue;
      // Private: a rule is usually the person's own words about their own taste.
      ids.push(addRule(repo, { name: r.name, applies: r.applies, text: r.text }, actor, "From the sessions.", "private"));
      titles.push(`Writing rules: ${r.name}`); newRules++;
    } catch { /* left out, as above */ }
  }
  // The map: a part's folders must exist here, what the person wrote last stands, and nothing unchanged is written again.
  const tracked = projectFiles(repo);
  const exists = (o: string) => o.endsWith("/") ? tracked.some((p) => p.startsWith(o)) : tracked.includes(o);
  const parts = withIndex(repo, (db) => partMaps(db));
  let newParts = 0;
  for (const m of plan.map) {
    const owns = [...new Set(m.owns.map((o) => o.replace(/^\.\//, "")).filter(exists))];
    if (!owns.length) continue;
    const before = parts.find((p) => p.part.toLowerCase() === m.part.toLowerCase());
    if (before && before.does === m.does && (before.layer ?? "") === (m.layer ?? "") && JSON.stringify(before.owns ?? []) === JSON.stringify(owns)) continue;
    if (before && byPerson(repo, before.id)) continue;
    if (!before && newParts >= NEW_PARTS) continue;
    try {
      const body = { map: { part: before?.part ?? m.part, does: m.does, ...(m.layer ? { layer: m.layer } : {}), owns, reads: m.reads, feeds: [], decisions: [] }, ...(before ? { supersedes: before.id } : {}) };
      ids.push(appendKept(repo, body as never, `Map: ${before?.part ?? m.part}`, "From the sessions.", actor, defaultTier(repo)).id);
      titles.push(`Map: ${before?.part ?? m.part}`);
      if (!before) newParts++;
    } catch { /* left out; the next update sees it again */ }
  }
  return { ids, titles };
}

const NEW_PARTS = 8;
/** Whether the person wrote this record, so an update leaves it be. */
const byPerson = (repo: string, id: string): boolean => readRecords(repo).some(([, r]) => r.id === id && r.session.agent === "person");

// ------------------------------------------------------------- one update

const lockFile = (repo: string) => marker(repo, "absorbing");

/**
 * One update: reads what's new, asks the model, applies its answer and moves
 * the cursor. Another update already running here, started under ten minutes
 * ago, makes this one do nothing.
 */
export function absorb(repo: string, opts: { runner?: Runner; captureRoot?: string; now?: number } = {}): { written: number; tokens: number } | null {
  const mode = absorbMode(repo).mode;
  if (mode === "off") return null;
  const lock = lockFile(repo);
  if (!lock) return null;
  try { if (Date.now() - statSync(lock).mtimeMs < 10 * 60_000) return null; } catch { /* no lock */ }
  writeFileSync(lock, String(process.pid));
  try {
    const cursor = readCursor(repo);
    const m = material(repo, cursor?.since ?? "", opts.captureRoot);
    const ran = new Date(opts.now ?? Date.now()).toISOString();
    if (!m.prompts.length && !m.attempts.length) return null;
    const runner = opts.runner ?? (mode === "codex" ? viaCodex : viaClaude);
    const answer = runner(SYSTEM, brief(basename(repo), goalTree(repo), listRules(repo), m, withIndex(repo, (db) => partMaps(db)), filesSummary(repo)));
    const session = [...m.prompts, ...m.attempts].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)!.session || "absorbed";
    const { ids, titles } = applyPlan(repo, parsePlan(answer.text), { kind: "agent", agent: "anvc", session });
    writeJson(cursorFile(repo)!, { since: m.until, ran, runs: (cursor?.runs ?? 0) + 1, tokens: (cursor?.tokens ?? 0) + answer.tokens } satisfies Cursor);
    logActivity({ kind: "absorbed", repo, session, records: ids, titles, via: mode, tokens: answer.tokens });
    return { written: ids.length, tokens: answer.tokens };
  } finally { rmSync(lock, { force: true }); }
}

/** Starts an update in the background when one is due, so the hook that calls this returns at once. */
export function absorbLater(repo: string, cli: string): void {
  try {
    if (!absorbDue(repo)) return;
    spawn(process.execPath, [cli, "absorb", "run", "--repo", repo], { detached: true, stdio: "ignore", env: process.env }).unref();
  } catch { /* the next turn tries again */ }
}
