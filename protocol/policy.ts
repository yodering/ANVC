/**
 * What anvc saves in a project, and who can read each part: the person's choice.
 *
 * Tiers decide who can read a record. This decides, field by field, whether
 * anvc saves something at all and whether it may leave the machine. People
 * disagree about this and are right to: a solo researcher wants everything
 * kept, a team wants decisions shared and prompts private, a public repository
 * wants almost nothing raw to leave. So there is no one default — there are
 * presets, and every field can be changed.
 *
 * Stored in .git/anvc/policy.json: per clone, never committed, because what a
 * person is willing to save about their own work is theirs to decide.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { marker } from "./localonly";
import { readJson, writeJson } from "./rawlog";
import { stateHome } from "./version";

export type Choice = "off" | "private" | "shared";
export type RetireMode = "auto" | "ask" | "off";
const RETIRE_MODES: readonly RetireMode[] = ["auto", "ask", "off"];
const TIERS: readonly Policy["tier"][] = ["private", "shared"];

/**
 * Every field a person can decide about.
 *
 * `raw` fields exist only in the private raw log, so they can be off or
 * private, never shared. `record` fields are parts of a record; shared means
 * they travel when the record does, private means they stay in a local copy.
 */
export const FIELDS = {
  // raw log
  prompts: { group: "raw", label: "Your prompts", what: "What you typed to the agent." },
  commands: { group: "raw", label: "Commands", what: "Every shell command the agent ran." },
  output: { group: "raw", label: "Command output", what: "What those commands printed, with secrets removed." },
  paths: { group: "raw", label: "Files read and edited", what: "The path of each file the agent read or edited." },
  delegations: { group: "raw", label: "Subagent briefs", what: "What the agent asked its subagents to do." },
  transcripts: { group: "raw", label: "Saved sessions", what: "A copy of each Claude Code session, kept after Claude Code deletes it at 30 days." },
  sources: { group: "raw", label: "Sources", what: "Pages, searches and documents the agent read, with the text it got back." },
  // record
  why: { group: "record", label: "Reason", what: "Why an attempt was kept or abandoned." },
  errors: { group: "record", label: "Errors", what: "The failing command and its error line." },
  files: { group: "record", label: "Files changed", what: "Which files the attempt changed." },
  evidence: { group: "record", label: "Evidence", what: "The files, lines and commits the agent cited." },
  recheck: { group: "record", label: "Recheck command", what: "One command that shows whether a dead end still fails." },
  steps: { group: "record", label: "Steps", what: "The reads, writes and commands of the attempt, in order." },
  detail_output: { group: "record", label: "Full output", what: "The whole output of what failed." },
  narrative: { group: "record", label: "Narrative", what: "The agent's account of what happened, in prose." },
  ruled_out: { group: "record", label: "Ruled out", what: "Approaches considered and set aside, with reasons." },
  not_investigated: { group: "record", label: "Not checked", what: "Questions the agent left open." },
  maps: { group: "record", label: "Part descriptions", what: "Descriptions shown on the project map." },
} as const;
export type Field = keyof typeof FIELDS;

export interface Policy {
  preset: string;
  fields: Record<Field, Choice>;
  retire: RetireMode;
  /** Where a record an agent writes goes when it does not say. */
  tier: "private" | "shared";
}

const all = (raw: Choice, record: Choice): Record<Field, Choice> =>
  Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.group === "raw" ? raw : record])) as Record<Field, Choice>;

export const PRESETS: Record<string, { label: string; what: string; policy: Omit<Policy, "preset"> }> = {
  "private-repo": {
    label: "Private",
    what: "For a repo only you use. Records are pushed so they follow you between machines. Prompts and the raw log stay here.",
    policy: { fields: all("private", "shared"), retire: "auto", tier: "shared" },
  },
  team: {
    label: "Team",
    what: "Your team sees why attempts ended and what failed. Prompts, full output and steps stay on your computer.",
    policy: {
      fields: { ...all("private", "shared"), detail_output: "private", steps: "private" },
      retire: "ask",
      tier: "shared",
    },
  },
  public: {
    label: "Public repository",
    what: "For open source. Each record's summary is pushed. Errors, output and steps stay on your computer.",
    policy: {
      fields: {
        ...all("private", "private"),
        why: "shared", files: "shared", recheck: "shared", ruled_out: "shared", maps: "shared",
      },
      retire: "ask",
      tier: "shared",
    },
  },
  minimal: {
    label: "Minimal",
    what: "Saves only the goal, outcome, reason, files and recheck command.",
    policy: {
      fields: {
        ...all("off", "off"),
        paths: "private", sources: "private", why: "shared", files: "shared", recheck: "shared",
      },
      retire: "off",
      tier: "shared",
    },
  },
};

export const DEFAULT_PRESET = "team";

const file = (repo: string) => marker(repo, "policy.json");

/**
 * Choices made once for every project, in ~/.anvc/defaults.json: the sharing
 * preset and Local only. A project follows them until it makes its own. Set
 * by the onboarding in a terminal (scripts/onboard.ts).
 */
export interface Defaults { preset?: string; localOnly?: boolean }
const defaultsFile = () => join(stateHome(), "defaults.json");
export const readDefaults = (): Defaults => readJson<Defaults>(defaultsFile(), {});
export function writeDefaults(change: Defaults): Defaults {
  const next = { ...readDefaults(), ...change };
  writeJson(defaultsFile(), next);
  return next;
}

/** The project's policy; else the preset chosen for every project; else the team preset. */
export function readPolicy(repo: string): Policy & { chosen: boolean } {
  const path = file(repo);
  const everywhere = readDefaults().preset;
  if ((!path || !existsSync(path)) && everywhere && Object.hasOwn(PRESETS, everywhere)) {
    return { preset: everywhere, ...structuredClone(PRESETS[everywhere]!.policy), chosen: true };
  }
  const base = { preset: DEFAULT_PRESET, ...PRESETS[DEFAULT_PRESET]!.policy };
  if (!path || !existsSync(path)) return { ...base, chosen: false };
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Policy>;
    return {
      // "solo" was the first name for the private-repo preset.
      preset: saved.preset === "solo" ? "private-repo" : saved.preset && Object.hasOwn(PRESETS, saved.preset) ? saved.preset : base.preset,
      // Merged over the preset, so a field added in a later version gets its
      // preset value instead of vanishing.
      fields: { ...base.fields, ...(saved.fields ?? {}) },
      // A file written by hand, or before these were checked, can hold anything.
      retire: RETIRE_MODES.includes(saved.retire!) ? saved.retire! : base.retire,
      tier: TIERS.includes(saved.tier!) ? saved.tier! : base.tier,
      chosen: true,
    };
  } catch {
    return { ...base, chosen: false };
  }
}

export function writePolicy(repo: string, policy: Policy): void {
  const path = file(repo);
  if (!path) throw new Error("not a git repository");
  if (!Object.hasOwn(PRESETS, policy.preset)) throw new Error(`unknown preset ${policy.preset}; one of ${Object.keys(PRESETS).join(", ")}`);
  for (const [k, v] of Object.entries(policy.fields)) {
    if (!Object.hasOwn(FIELDS, k)) throw new Error(`unknown field ${k}`);
    const f = FIELDS[k as Field];
    if (!["off", "private", "shared"].includes(v)) throw new Error(`${k}: ${v} is not off, private or shared`);
    // The raw log is private by construction; nothing in it can be shared.
    if (f.group === "raw" && v === "shared") throw new Error(`${k} is part of the raw log and cannot be shared`);
  }
  if (!RETIRE_MODES.includes(policy.retire)) throw new Error("retire must be auto, ask or off");
  // TIER_PREFIX has no entry for any other tier, so a record's ref would start "undefined".
  if (!TIERS.includes(policy.tier)) throw new Error("tier must be private or shared");
  writeJson(path, { preset: policy.preset, fields: policy.fields, retire: policy.retire, tier: policy.tier });
}

/**
 * One line that carries a whole policy, so people can pass around a setup
 * that works for them: `team+output=private,steps=shared;retire=auto`.
 */
export function exportPolicy(policy: Policy): string {
  const base = PRESETS[policy.preset]?.policy;
  const changed = Object.entries(policy.fields)
    .filter(([k, v]) => base?.fields[k as Field] !== v)
    .map(([k, v]) => `${k}=${v}`);
  const extras = [
    ...(base?.retire !== policy.retire ? [`retire=${policy.retire}`] : []),
    ...(base?.tier !== policy.tier ? [`tier=${policy.tier}`] : []),
  ];
  return `${policy.preset}${changed.length ? `+${changed.join(",")}` : ""}${extras.length ? `;${extras.join(";")}` : ""}`;
}

export function importPolicy(line: string): Policy {
  const [head = "", ...rest] = line.trim().split(";");
  const [preset = DEFAULT_PRESET, changes = ""] = head.split("+");
  if (!Object.hasOwn(PRESETS, preset)) throw new Error(`unknown preset ${preset}; one of ${Object.keys(PRESETS).join(", ")}`);
  const base = PRESETS[preset]!;
  const policy: Policy = { preset, ...structuredClone(base.policy) };
  for (const pair of changes.split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (!Object.hasOwn(FIELDS, k!)) throw new Error(`unknown field ${k}`);
    policy.fields[k as Field] = v as Choice;
  }
  for (const pair of rest) {
    const [k, v] = pair.split("=");
    if (k === "retire") policy.retire = v as RetireMode;
    else if (k === "tier") policy.tier = v as "private" | "shared";
  }
  return policy;
}
