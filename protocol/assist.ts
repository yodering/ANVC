/**
 * How much ANVC does on its own, as opposed to when someone asks.
 *
 * Everything ANVC puts in front of an agent unasked changes what it does, for
 * better or worse: a stale record can steer an agent wrong. Memory tools that talk too much are the
 * complaint people make most, and how much is right depends on the person and
 * the agent: one with little context of its own is the easiest to steer. So
 * it is a choice, made once when setting up and changed any time, per project
 * or for every project.
 *
 * Three levels, each a set of moments, and any moment can be switched on its
 * own. Kept apart from the sharing policy, so picking who reads records never
 * changes how much the agent is told.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { marker } from "./localonly";
import { readJson, writeJson } from "./rawlog";
import { stateHome } from "./version";

export const MOMENTS = {
  briefing: { label: "Session start", what: "Past dead ends, what works and what the last session left, when a session starts or its context is compacted." },
  goals: { label: "Goals", what: "The project's goals and which are done, when a session starts or its context is compacted." },
  prompts: { label: "Each prompt", what: "Past attempts that match what you just asked." },
  failures: { label: "Failed commands", what: "Past attempts that hit the same error, when a command fails." },
  subagents: { label: "Subagents", what: "The open dead ends, when your agent hands work to a subagent." },
  remind: { label: "Save reminder", what: "Asks your agent once to record its work if it edited files and saved nothing." },
  autosave: { label: "Save from the log", what: "Saves what your agent didn't record, privately, marked as having no reason." },
  checks: { label: "Run checks", what: "Runs a dead end's test command before showing it, to see if it still fails." },
  notices: { label: "Notes to you", what: "A line in your terminal after a session saying what ANVC did." },
  rules: { label: "Writing rules", what: "The project's writing rules: a list when a session starts, and a rule set's text before your agent writes what it covers." },
  tools: { label: "Tool notes", what: "Notes on when to use which tool, at the start of a session and after compaction." },
  status: { label: "Status", what: "What's in progress, done recently and up next, when a session starts or its context is compacted." },
} as const;
export type Moment = keyof typeof MOMENTS;

export type Level = "auto" | "start" | "ask";

/** Every moment on, or every moment off, in the order MOMENTS lists them. */
const every = (on: boolean) => Object.fromEntries(Object.keys(MOMENTS).map((k) => [k, on])) as Record<Moment, boolean>;

export const LEVELS: Record<Level, { label: string; what: string; moments: Record<Moment, boolean> }> = {
  auto: {
    label: "Automatic",
    what: "Shows your agent past attempts as it works.",
    moments: every(true),
  },
  start: {
    label: "At the start",
    what: "Briefs your agent when a session starts, then stays quiet.",
    moments: { ...every(true), prompts: false, failures: false, subagents: false },
  },
  ask: {
    label: "When asked",
    what: "Says nothing unless you or your agent ask. Work is still saved.",
    moments: { ...every(false), autosave: true },
  },
};

export const DEFAULT_LEVEL: Level = "auto";

export interface Assist {
  level: Level;
  moments: Record<Moment, boolean>;
  /** Where this came from: the project, the default for every project, or nothing chosen. */
  from: "project" | "everywhere" | "default";
}

type Saved = { level?: Level; moments?: Partial<Record<Moment, boolean>> };

const everywhereFile = () => join(stateHome(), "assist.json");
const projectFile = (repo: string) => marker(repo, "assist.json");
const read = (file: string | null) => file ? readJson<Saved | null>(file, null) : null;

function resolve(saved: Saved, from: Assist["from"]): Assist {
  const level = saved.level && Object.hasOwn(LEVELS, saved.level) ? saved.level : DEFAULT_LEVEL;
  return { level, moments: { ...LEVELS[level].moments, ...(saved.moments ?? {}) }, from };
}

/** What ANVC does on its own here: the project's choice, else the default for every project. */
export function readAssist(repo: string): Assist {
  const project = read(projectFile(repo));
  if (project) return resolve(project, "project");
  const everywhere = read(everywhereFile());
  if (everywhere) return resolve(everywhere, "everywhere");
  return resolve({}, "default");
}

/** The default for every project, whatever one project chose. */
export function readEverywhere(): Assist {
  const everywhere = read(everywhereFile());
  return everywhere ? resolve(everywhere, "everywhere") : resolve({}, "default");
}

/**
 * Saves a choice. A level resets the moments to that level's; a moment
 * changes only itself. `repo` null saves the default for every project.
 */
export function writeAssist(repo: string | null, change: { level?: Level; moment?: Moment; on?: boolean }): Assist {
  const file = repo ? projectFile(repo) : everywhereFile();
  if (!file) throw new Error("not a git repository");
  const current = repo ? readAssist(repo) : readEverywhere();
  let saved: Saved;
  if (change.level) {
    if (!Object.hasOwn(LEVELS, change.level)) throw new Error(`level must be one of ${Object.keys(LEVELS).join(", ")}`);
    saved = { level: change.level };
  } else if (change.moment) {
    if (!Object.hasOwn(MOMENTS, change.moment)) throw new Error(`unknown moment ${change.moment}; one of ${Object.keys(MOMENTS).join(", ")}`);
    const base = LEVELS[current.level].moments;
    const moments = { ...current.moments, [change.moment]: Boolean(change.on) };
    // Store only what differs from the level, so the level stays the choice.
    const diff = Object.fromEntries(Object.entries(moments).filter(([k, v]) => base[k as Moment] !== v));
    saved = { level: current.level, ...(Object.keys(diff).length ? { moments: diff } : {}) };
  } else {
    throw new Error("nothing to change");
  }
  writeJson(file, saved);
  return repo ? readAssist(repo) : readEverywhere();
}

/** Drops the project's own choice, so it follows the default for every project. */
export function clearProjectAssist(repo: string): void {
  const file = projectFile(repo);
  if (file) rmSync(file, { force: true });
}
