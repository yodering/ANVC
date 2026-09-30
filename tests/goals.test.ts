/**
 * Goals keep what the project is for, and how far each part has got, across
 * compactions: the latest change wins, every version stays, and a fetched
 * record can't change a goal written here.
 */
import { expect, test } from "bun:test";
import { addGoal, allGoals, answerGoal, changeGoal, goalsBrief, goalTree, readGoals, type Goal } from "../protocol/goals";
import { options } from "../protocol/options";
import { tried, withIndex } from "../protocol/query";
import { appendRecord, validateRecord, type CheckpointRecord } from "../protocol/record";
import { writeAssist } from "../protocol/assist";
import { repoView } from "../server/api";
import { cli, context, fetched, gitRepo, rec, tmp, tool } from "./helpers";

const agent = { kind: "agent" as const, agent: "claude-code", session: "s1" };
const person = { kind: "person" as const };
const find = (repo: string, id: string): Goal => allGoals(goalTree(repo)).find((g) => g.id === id)!;
const change = (of: string, status: "todo" | "doing" | "done" | "dropped", title = "Ship the Project page") =>
  rec({ objective: { title, status, of }, intent: { goal: `Change: ${title}`, why: "from the fork" } });

test("the latest change wins, and every version stays with who made it and why", () => {
  const repo = gitRepo({ commit: true });
  const id = addGoal(repo, { title: "Ship the Project page", why: "Goals get lost after compaction" }, person);
  changeGoal(repo, id, { status: "doing", why: "Started on the fold" }, agent);
  changeGoal(repo, id, { status: "done", why: "tests/goals.test.ts passes" }, agent);
  changeGoal(repo, id, { title: "Ship the Project page's Goals section", why: "Narrower" }, person);

  const goal = find(repo, id);
  expect(goal.status).toBe("done");
  expect(goal.title).toBe("Ship the Project page's Goals section");
  expect(goal.why).toBe("Goals get lost after compaction");
  expect(goal.versions.map((v) => [v.status, v.by, v.why])).toEqual([
    ["todo", "person", "Goals get lost after compaction"],
    ["doing", "agent", "Started on the fold"],
    ["done", "agent", "tests/goals.test.ts passes"],
    ["done", "person", "Narrower"],
  ]);
  expect(goal.versions[1]!.session).toBe("s1");
  // readGoals folds the versions in the index to each goal as it is now.
  expect(withIndex(repo, (db) => readGoals(db).map((g) => ({ id: g.id, status: g.status })))).toEqual([{ id, status: "done" }]);
  // A change to what it already is writes nothing.
  changeGoal(repo, id, { status: "done" }, agent);
  expect(find(repo, id).versions).toHaveLength(4);
}, 30_000);

test("sub-goals count toward their goal, dropped ones don't, and attempts that serve one are listed", () => {
  const repo = gitRepo({ commit: true });
  const top = addGoal(repo, { title: "Project page" }, person);
  const [a, b, c] = ["Goals", "Writing rules", "Tools"].map((title) => addGoal(repo, { title, parent: top }, person));
  changeGoal(repo, a!, { status: "done" }, person);
  changeGoal(repo, c!, { status: "dropped" }, person);
  appendRecord(repo, rec({ intent: { goal: "Fold goal versions in the index" }, serves: a }));

  const [goal] = goalTree(repo);
  expect(goal!.subgoals.map((g) => g.id)).toEqual([a, b, c]);
  expect([goal!.done, goal!.total]).toEqual([1, 2]);
  expect(goal!.subgoals[0]!.attempts.map((x) => x.intent)).toEqual(["Fold goal versions in the index"]);
  expect(() => addGoal(repo, { title: "Orphan", parent: "01K00000000000000000000000" }, person)).toThrow("no goal");
}, 30_000);

test("a fetched record can't change a goal written here, and can change one that was fetched", () => {
  const repo = gitRepo({ commit: true });
  const mine = addGoal(repo, { title: "Ship the Project page" }, person);
  fetched(repo, change(mine, "dropped"));
  const goal = find(repo, mine);
  expect(goal.status).toBe("todo");
  // Shown, from where it came, and not applied.
  expect(goal.versions.at(-1)).toMatchObject({ status: "dropped", from: "fork", counts: false });

  const theirs = rec({ objective: { title: "Port to Tauri", status: "todo" }, intent: { goal: "Goal: Port to Tauri" } });
  fetched(repo, theirs);
  fetched(repo, change(theirs.id, "doing", "Port to Tauri"));
  expect(find(repo, theirs.id)).toMatchObject({ status: "doing", from: "fork" });
  // A change made here applies to a fetched goal too.
  changeGoal(repo, theirs.id, { status: "done" }, person);
  expect(find(repo, theirs.id).status).toBe("done");
}, 30_000);

test("a goal record isn't an attempt: the work log and searches leave it out", () => {
  const repo = gitRepo({ commit: true });
  addGoal(repo, { title: "Cache the ref index" }, person);
  appendRecord(repo, rec({ intent: { goal: "Cache the ref index in memory" } }));
  expect(repoView(repo).turns.map((t) => t.intent)).toEqual(["Cache the ref index in memory"]);
  expect(withIndex(repo, (db) => tried(db, "ref index").map((h) => h.intent))).toEqual(["Cache the ref index in memory"]);
}, 30_000);

test("an objective has a title and a known status", () => {
  const goal = (objective: object) => validateRecord(rec({ objective } as Partial<CheckpointRecord>));
  expect(() => goal({ title: "x", status: "finished" })).toThrow("objective.status");
  expect(() => goal({ title: " ", status: "todo" })).toThrow("objective.title");
  expect(() => goal({ title: "x".repeat(201), status: "todo" })).toThrow("objective.title");
  expect(() => goal({ title: "x", status: "todo", of: "nope" })).toThrow("objective.of");
  expect(goal({ title: "x", status: "doing" }).objective!.status).toBe("doing");
});

test("an agent reads the goals and changes one, with a reason", () => {
  const repo = gitRepo({ commit: true });
  expect(tool(repo, "anvc_goals")).toContain("No goals recorded here yet");
  const added = tool(repo, "anvc_goal", { title: "Ship the Project page", why: "the person asked" });
  const id = /id ([0-9A-Z]{26})/.exec(added)![1]!;
  const sub = /id ([0-9A-Z]{26})/.exec(tool(repo, "anvc_goal", { title: "Goals section", parent: id, status: "doing" }))![1]!;
  expect(tool(repo, "anvc_goal", { id: sub, status: "done" })).toContain("Say why");
  expect(tool(repo, "anvc_goal", { id: sub, status: "finished", why: "x" })).toContain("status must be one of");
  expect(tool(repo, "anvc_goal", { id: sub, status: "done", why: "bun test tests/goals.test.ts passes" })).toBe("Goals section is now Done.");
  expect(tool(repo, "anvc_goals")).toBe(`- To do: Ship the Project page, 1 of 1 done, id ${id}\n  - Done: Goals section, id ${sub}`);
  expect(find(repo, sub).versions.at(-1)).toMatchObject({ by: "agent", agent: "claude-code", why: "bun test tests/goals.test.ts passes" });
}, 30_000);

test("a person adds goals and changes their status from the command line", () => {
  const repo = gitRepo({ commit: true });
  const add = cli(repo, "goal", "add", "Ship", "the", "Project", "page");
  expect(add.code).toBe(0);
  const id = /goal ([0-9A-Z]{26})/.exec(add.out)![1]!;
  expect(cli(repo, "goal", "add", "Goals section", "--parent", id).out).toContain("Added sub-goal");
  expect(cli(repo, "goal", id, "doing", "--why", "started").out).toContain("Ship the Project page is now In progress.");
  expect(cli(repo, "goals").out).toContain(`- In progress: Ship the Project page, 0 of 1 done, id ${id}\n  - To do: Goals section`);
  expect(find(repo, id).versions.at(-1)).toMatchObject({ by: "person", why: "started" });
  expect(cli(repo, "goal", id, "finished").code).toBe(2);
  expect(cli(repo, "goal", "01K00000000000000000000000", "done").out).toContain("no goal");
}, 30_000);

test("a session starts with the goals, and hears them again after compaction", () => {
  const repo = gitRepo({ commit: true });
  const state = tmp("anvc-goals-state-");
  const top = addGoal(repo, { title: "Ship the Project page" }, person);
  const done = addGoal(repo, { title: "Goals section", parent: top }, person);
  addGoal(repo, { title: "Tools section", parent: top }, person);
  changeGoal(repo, done, { status: "done" }, person);
  changeGoal(repo, top, { status: "doing" }, person);
  const start = (source: string, session = "s1") => context("SessionStart",
    { hook_event_name: "SessionStart", session_id: session, cwd: repo, source }, { ANVC_STATE_DIR: state });

  const first = start("startup")!;
  expect(first).toContain("anvc: this project's goals, 0 of 1 done.");
  expect(first).toContain(`- In progress: Ship the Project page, 1 of 2 done, id ${top}\n  - To do: Tools section`);
  expect(first).toContain("  - Done: Goals section");
  expect(start("startup")).toBeUndefined();
  expect(start("compact")).toContain("Ship the Project page");

  // Off at the "when asked" level, and on its own switch whatever the briefing says.
  writeAssist(repo, { level: "ask" });
  expect(start("startup", "s2")).toBeUndefined();
  writeAssist(repo, { moment: "goals", on: true });
  expect(start("startup", "s3")).toContain("Ship the Project page");
}, 60_000);

test("the goals in a briefing fit its budget, open ones first", () => {
  const goal = (title: string, status: Goal["status"]): Goal => ({
    id: "01K00000000000000000000000", title, status, parent: null, why: null, tier: "shared", from: null,
    versions: [], subgoals: [], done: 0, total: 0, attempts: [], proposal: null,
  });
  const many = Array.from({ length: 40 }, (_, i) => goal(`Goal number ${i} with a longer title than most`, i < 30 ? "done" : "todo"));
  const text = goalsBrief([...many, goal("Gone", "dropped")], 1200)!;
  expect(text.length).toBeLessThanOrEqual(1200);
  expect(text.split("\n")[1]).toContain("To do: Goal number 30");
  expect(text).toMatch(/\d+ more: anvc_goals lists every goal\.$/);
  expect(text).not.toContain("Gone");
  expect(goalsBrief([goal("Gone", "dropped")], 1200)).toBeNull();
});

test("with Approve goals on, what an agent adds or changes waits for the person, and theirs applies at once", () => {
  const repo = gitRepo({ commit: true });
  const setting = () => options(repo, repo).settings.find((x) => x.key === "approvegoals")!;
  expect(setting()).toMatchObject({ here: "off", recommended: "off", asks: false });
  expect(cli(repo, "approve-goals", "on").out).toContain("wait until you accept them");
  expect(setting().here).toBe("on");

  const top = addGoal(repo, { title: "Ship the Project page" }, person);
  expect(find(repo, top).proposal).toBeNull();
  expect(tool(repo, "anvc_goal", { id: top, status: "done", why: "the page renders" })).toContain("Proposed the change to Ship the Project page.");
  expect(find(repo, top)).toMatchObject({ status: "todo", proposal: { status: "done", added: false, why: "the page renders" } });
  // The same proposal again writes nothing.
  changeGoal(repo, top, { status: "done", why: "again" }, agent);
  expect(find(repo, top).versions).toHaveLength(2);
  const sub = /id ([0-9A-Z]{26})/.exec(tool(repo, "anvc_goal", { title: "Goals section", parent: top }))![1]!;
  expect(find(repo, sub).proposal).toMatchObject({ added: true });
  // A proposed sub-goal doesn't count toward its goal until it's accepted.
  expect(find(repo, top).total).toBe(0);
  const listed = cli(repo, "goals").out;
  expect(listed).toContain(`- To do: Ship the Project page, id ${top}, proposed: Done, not accepted yet`);
  expect(listed).toContain(`  - To do: Goals section, id ${sub}, proposed, not accepted yet`);
  expect(listed).toContain("anvc goal accept <id>");
  expect(tool(repo, "anvc_goals")).toContain("proposed: Done, not accepted yet");

  expect(cli(repo, "goal", "accept", top).out).toContain("Accepted. Ship the Project page is Done.");
  expect(find(repo, top)).toMatchObject({ status: "done", proposal: null });
  expect(find(repo, top).versions.at(-1)).toMatchObject({ by: "person", why: null, proposed: false });
  // Declining a proposed goal drops it; it stays in the history.
  answerGoal(repo, sub, false);
  expect(find(repo, sub)).toMatchObject({ status: "dropped", proposal: null });
  expect(() => answerGoal(repo, sub, true)).toThrow("Nothing is waiting");

  // Declining a change keeps the goal as it was; a change the person makes answers it too.
  changeGoal(repo, top, { status: "doing", why: "reopened" }, agent);
  answerGoal(repo, top, false, "it shipped");
  expect(find(repo, top)).toMatchObject({ status: "done", proposal: null });
  expect(find(repo, top).versions.at(-1)!.why).toBe("it shipped");
  changeGoal(repo, top, { title: "Ship it", why: "shorter" }, agent);
  changeGoal(repo, top, { status: "dropped" }, person);
  expect(find(repo, top)).toMatchObject({ title: "Ship the Project page", status: "dropped", proposal: null });

  cli(repo, "approve-goals", "off");
  expect(tool(repo, "anvc_goal", { id: top, status: "todo", why: "back on" })).toBe("Ship the Project page is now To do.");
}, 60_000);
