/**
 * Goals: what the project is for, split into sub-goals, and how far each has got.
 *
 * After each context compaction the person had to say again what the goals
 * were and which were done. So goals are records, versioned the way results
 * are (protocol/results.ts): a change is a new record whose `objective.of`
 * names the goal, the latest change wins, and every earlier version stays
 * with who made it, when and why. Undoing a change is one more change, back
 * to the version before.
 *
 * A fetched record (refs/remotes/*) was written by whoever can push to that
 * remote, so it can change only a goal that was fetched too. The index holds
 * every version (the goals table in protocol/query.ts), and readGoals folds them.
 *
 * A project can ask for the person's OK (Approve goals, off by default).
 * Then what an agent adds or changes is written `proposed`, counts for
 * nothing, and waits: the person's accept is one more version with the
 * proposal's title and status, a decline one with the goal as it was. A
 * later proposal replaces an unanswered one, as a later version does.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { textArg } from "./args";
import { marker } from "./localonly";
import { defaultTier, GOAL_STATUSES, type CheckpointRecord, type GoalStatus, type Tier } from "./record";
import { fit, printable, withIndex } from "./query";
import { appendKept, type Actor } from "./results";

export const GOAL_LABELS: Record<GoalStatus, string> = { todo: "To do", doing: "In progress", done: "Done", dropped: "Dropped" };

export interface GoalVersion {
  id: string;
  ts: string;
  title: string;
  status: GoalStatus;
  by: "person" | "agent";
  agent: string;
  session: string;
  why: string | null;
  /** The remote a fetched version came from. */
  from: string | null;
  /** False for a fetched change to a goal written here: it's shown and never applied. */
  counts: boolean;
  /** An agent's version waiting for the person. */
  proposed: boolean;
}

/** The proposal waiting for the person; `added` when the goal itself is waiting. */
type Proposal = GoalVersion & { added: boolean };

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  parent: string | null;
  /** Why it was added. */
  why: string | null;
  tier: Tier;
  /** The remote it was fetched from, or null for a goal written here. */
  from: string | null;
  /** Oldest first; the first is the goal as it was added. */
  versions: GoalVersion[];
  subgoals: Goal[];
  /** Sub-goals done, out of those not dropped. */
  done: number;
  total: number;
  /** Attempts whose `serves` names this goal, newest first. */
  attempts: Array<{ id: string; intent: string; status: string; ts: string }>;
  /** An agent's addition or change the person hasn't answered, when the project asks. */
  proposal: Proposal | null;
}

type Row = { id: string; goal: string; title: string; parent: string | null; status: GoalStatus; ts: string; agent: string; run_id: string; why: string | null; tier: Tier; remote: string | null; proposed: number };

/** Whether an agent's goal changes wait for the person here. Kept beside local only, in .git/anvc. */
export const approvalOn = (repo: string): boolean => { const path = marker(repo, "approve-goals"); return path !== null && existsSync(path); };

export function setApproval(repo: string, on: boolean): void {
  const path = marker(repo, "approve-goals");
  if (!path) throw new Error("not a git repository");
  if (!on) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "Goals an agent adds or changes wait for the person to accept them.\n");
}

const proposes = (repo: string, actor: Actor) => actor.kind === "agent" && approvalOn(repo);
const same = (a: { title: string; status: GoalStatus }, b: { title: string; status: GoalStatus }) => a.title === b.title && a.status === b.status;

/**
 * Every goal as it is now, top-level goals in the order they were added, each
 * holding its sub-goals. A goal is its latest version that counts: a fetched
 * change counts only on a goal that was fetched too, and a proposed change
 * waits for the person. A proposed goal is shown as it was proposed until
 * they answer. The parent is the one the goal was added under.
 */
export function readGoals(db: Database): Goal[] {
  const rows = db.prepare(`SELECT * FROM goals ORDER BY ts, id`).all() as Row[];
  if (!rows.length) return [];
  const byId = new Map<string, Goal>();
  const roots: Goal[] = [];
  for (const g of rows) {
    if (g.id !== g.goal) continue;
    const goal: Goal = { id: g.id, title: g.title, status: g.status, parent: g.parent, why: g.why, tier: g.tier, from: g.remote, versions: [], subgoals: [], done: 0, total: 0, attempts: [], proposal: null };
    // Only under a goal added before it, so parents written by hand can't make a loop.
    const parent = g.parent ? byId.get(g.parent) : undefined;
    (parent ? parent.subgoals : roots).push(goal);
    byId.set(g.id, goal);
  }
  for (const v of rows) {
    const goal = byId.get(v.goal);
    if (!goal) continue;
    goal.versions.push({
      id: v.id, ts: v.ts, title: v.title, status: v.status, by: v.agent === "person" && !v.remote ? "person" : "agent",
      agent: v.agent, session: v.run_id, why: v.why, from: v.remote, counts: !v.remote || Boolean(goal.from), proposed: Boolean(v.proposed),
    });
  }
  const attempts = db.prepare(`SELECT id, intent, status, ts, serves FROM records WHERE serves IN (SELECT id FROM goals WHERE id = goal) ORDER BY ts DESC`)
    .all() as Array<{ id: string; intent: string; status: string; ts: string; serves: string }>;
  for (const { serves, ...a } of attempts) byId.get(serves)!.attempts.push(a);
  for (const goal of byId.values()) {
    const counted = goal.versions.filter((v) => v.counts);
    const now = counted.findLast((v) => !v.proposed || v.id === goal.id)!;
    goal.title = now.title;
    goal.status = now.status;
    // The latest proposal since the last version that counts, if any.
    const settled = counted.findLastIndex((v) => !v.proposed);
    const waiting = counted.slice(settled + 1).at(-1);
    if (waiting) goal.proposal = { ...waiting, added: settled === -1 };
  }
  for (const goal of byId.values()) {
    const live = goal.subgoals.filter((s) => s.status !== "dropped" && !s.proposal?.added);
    goal.total = live.length;
    goal.done = live.filter((s) => s.status === "done").length;
  }
  return roots;
}

export const goalTree = (repo: string): Goal[] => withIndex(repo, readGoals);

/** Every goal in the tree, sub-goals included. */
export const allGoals = (roots: Goal[]): Goal[] => roots.flatMap((g) => [g, ...allGoals(g.subgoals)]);

/** The goal with this id as it is now; there being none is an error. */
export function goalOf(repo: string, id: string): Goal {
  const goal = allGoals(goalTree(repo)).find((g) => g.id === id);
  if (!goal) throw new Error(`no goal ${id}`);
  return goal;
}

function write(repo: string, objective: NonNullable<CheckpointRecord["objective"]>, why: string | undefined, actor: Actor, tier: Tier): string {
  if (proposes(repo, actor)) objective = { ...objective, proposed: true };
  return appendKept(repo, { objective }, `${objective.of ? GOAL_LABELS[objective.status] : "Goal"}: ${objective.title}`, why, actor, tier).id;
}

/** Adds a goal, or a sub-goal of `parent`. Returns its id. */
export function addGoal(repo: string, input: { title: string; parent?: string; status?: GoalStatus; why?: string }, actor: Actor): string {
  if (input.parent) goalOf(repo, input.parent);
  return write(repo, { title: input.title.trim(), ...(input.parent ? { parent: input.parent } : {}), status: input.status ?? "todo" }, input.why, actor, defaultTier(repo));
}

/** Changes a goal's status or title: a new version, so the earlier ones stay. Returns the goal as it is now. */
export function changeGoal(repo: string, id: string, change: { status?: GoalStatus; title?: string; why?: string }, actor: Actor): Goal {
  const goal = goalOf(repo, id);
  const title = change.title?.trim() || goal.title;
  const status = change.status ?? goal.status;
  if (same({ title, status }, goal) || (proposes(repo, actor) && goal.proposal && same({ title, status }, goal.proposal))) return goal;
  write(repo, { title, status, of: id }, change.why, actor, goal.tier);
  return goalOf(repo, id);
}

/**
 * The person accepts or declines what an agent proposed. Declining a
 * proposed goal drops it, so it stays in the history.
 */
export function answerGoal(repo: string, id: string, accept: boolean, why?: string): Goal {
  const goal = goalOf(repo, id);
  const p = goal.proposal;
  if (!p) throw new Error(`Nothing is waiting for an answer on ${goal.title}.`);
  const to = accept ? p : p.added ? { title: goal.title, status: "dropped" as const } : goal;
  write(repo, { title: to.title, status: to.status, of: id }, why, { kind: "person" }, goal.tier);
  return goalOf(repo, id);
}

/** A proposal as the end of a line: `proposed: "New title", Done, not accepted yet`. */
function proposalText(goal: Goal): string | null {
  const p = goal.proposal;
  if (!p) return null;
  if (p.added) return "proposed, not accepted yet";
  const parts = [...(p.title !== goal.title ? [`"${printable(p.title)}"`] : []), ...(p.status !== goal.status ? [GOAL_LABELS[p.status]] : [])];
  return `proposed: ${parts.join(", ")}, not accepted yet`;
}

const ORDER: GoalStatus[] = ["doing", "todo", "done", "dropped"];

/**
 * The tree as lines, sub-goals indented under their goal. A fetched goal's
 * title is quoted and says where it came from: anyone who can push there
 * wrote it.
 */
export function goalLines(roots: Goal[], opts: { dropped?: boolean; open?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (list: Goal[], depth: number) => {
    const shown = list.filter((g) => opts.dropped || g.status !== "dropped");
    if (opts.open) shown.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
    for (const g of shown) {
      const title = g.from ? `"${printable(g.title)}" (from ${g.from})` : printable(g.title);
      const waiting = proposalText(g);
      out.push(`${"  ".repeat(depth)}- ${GOAL_LABELS[g.status]}: ${title}${g.total ? `, ${g.done} of ${g.total} done` : ""}, id ${g.id}${waiting ? `, ${waiting}` : ""}`);
      walk(g.subgoals, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/**
 * What an agent starts with, and starts with again after compaction: the
 * goals in progress first, then to do, then done, inside `max` characters.
 * Dropped goals are left out. A line that doesn't fit is left out whole.
 */
export function goalsBrief(roots: Goal[], max: number): string | null {
  const lines = goalLines(roots, { open: true });
  if (!lines.length) return null;
  const live = roots.filter((g) => g.status !== "dropped" && !g.proposal?.added);
  const head = `anvc: this project's goals, ${live.filter((g) => g.status === "done").length} of ${live.length} done. `
    + "When a goal's status changes, record it with anvc_goal. Pass the id of the goal your work is for as serves to anvc_checkpoint.";
  const more = (n: number) => `${n} more: anvc_goals lists every goal.`;
  const kept = fit(lines, max - head.length - more(lines.length).length - 1);
  const left = lines.length - kept.length;
  return [head, ...kept, ...(left ? [more(left)] : [])].join("\n");
}

const STATUS_HELP = "todo: not started. doing: in progress. done: finished. dropped: no longer wanted.";

/** The MCP tools, answered by goalTool below. */
export const GOAL_TOOLS = [
  {
    name: "anvc_goals",
    description:
      "This project's goals and sub-goals: each one's status (To do, In progress, Done, Dropped), how many of its sub-goals are done, and its id. "
      + "Call it when you start work or lose track of what is done. Pass a goal's id as serves to anvc_checkpoint, so the work counts toward it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "anvc_goal",
    description:
      "Add a goal or sub-goal, or change a goal's status or title. Every change is kept with who made it and why, and the person can undo it. "
      + "Where the project asks for approval, what you add or change is proposed and applies once the person accepts it. "
      + "Mark a goal doing when you start on it and done when it is finished, and say what shows it in why: the commit, the test, the file.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "To change a goal: its id, from anvc_goals. Leave it out to add one." },
        title: { type: "string", description: "To add: the goal in one line, under 200 characters. To change: a new title." },
        parent: { type: "string", description: "To add a sub-goal: the id of the goal it belongs to." },
        status: { type: "string", enum: [...GOAL_STATUSES], description: `${STATUS_HELP} A new goal starts as todo.` },
        why: { type: "string", description: "Why: required for a change. The person reads it next to the change." },
      },
    },
  },
];

export function goalTool(repo: string, name: string, args: Record<string, unknown>, actor: Actor): string {
  if (name === "anvc_goals") {
    const lines = goalLines(goalTree(repo), { dropped: true });
    return lines.length ? lines.join("\n") : "No goals recorded here yet. When the person says what the project is for, add them with anvc_goal.";
  }
  const text = (key: string) => textArg(args, key);
  const status = text("status") as GoalStatus | undefined;
  if (status && !GOAL_STATUSES.includes(status)) return `status must be one of ${GOAL_STATUSES.join(", ")}.`;
  const id = text("id");
  const asks = proposes(repo, actor);
  const wait = " The person sees it as proposed, and it applies once they accept it.";
  try {
    if (!id) {
      const title = text("title");
      if (!title) return "Give a title to add a goal, or an id to change one.";
      const added = addGoal(repo, { title, parent: text("parent"), status, why: text("why") }, actor);
      return `${asks ? "Proposed" : "Added"} ${text("parent") ? "sub-goal" : "goal"} ${title} (${GOAL_LABELS[status ?? "todo"]}), id ${added}.${asks ? wait : ""} Pass this id as serves to anvc_checkpoint for work on it.`;
    }
    if (!status && !text("title")) return "Give a status or a title to change.";
    if (!text("why")) return "Say why: the person reads it next to the change.";
    const goal = changeGoal(repo, id, { status, title: text("title"), why: text("why") }, actor);
    if (asks) return `Proposed the change to ${goal.title}.${wait}`;
    return status ? `${goal.title} is now ${GOAL_LABELS[goal.status]}.` : `Renamed to ${goal.title}.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
