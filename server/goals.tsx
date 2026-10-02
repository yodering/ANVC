/**
 * Goals and sub-goals, with their status and history.
 *
 * Each goal shows its status and, when it has sub-goals, how many are done.
 * Opening one shows why it was added, every change with who made it, when and
 * why, and the attempts that served it. A person adds goals, changes status,
 * renames, and undoes a change, which is one more change back to the version
 * before (protocol/goals.ts). Where the project asks for approval, what an
 * agent adds or changes waits here for the person to accept or decline.
 */
import { useState } from "preact/hooks";
import type { Goal, GoalVersion } from "../protocol/goals";
import type { GoalStatus } from "../protocol/record";
import { Icon, OutcomeBadge, Segmented, TitleForm, useLive, when, type Save } from "./widgets";
import { AbsorbNote } from "./absorb";
import "./goals.css";

const LABEL: Record<GoalStatus, string> = { todo: "To do", doing: "In progress", done: "Done", dropped: "Dropped" };
const STATUSES = Object.entries(LABEL) as Array<[GoalStatus, string]>;
const MARKED: Record<GoalStatus, string> = { todo: "Marked to do", doing: "Marked in progress", done: "Marked done", dropped: "Dropped" };

type Change = { id?: string; parent?: string; title?: string; status?: GoalStatus; why?: string; answer?: "accept" | "decline" };
type Shape = Pick<GoalVersion, "title" | "status">;
const same = (a: Shape, b: Shape) => a.title === b.title && a.status === b.status;

/** What a version changed from the one before it. */
function what(v: Shape, before: Shape | undefined): string {
  if (!before) return "Added";
  const parts = [
    ...(v.title !== before.title ? [`Renamed from “${before.title}”`] : []),
    ...(v.status !== before.status ? [MARKED[v.status]] : []),
  ];
  return parts.join(", ") || "No change";
}

const who = (v: GoalVersion) =>
  v.from ? `${v.agent} on ${v.from}` : v.by === "person" ? "You" : `${v.agent}, session ${v.session.slice(0, 8)}`;

function History({ goal, save }: { goal: Goal; save: Save<Change> }) {
  // `last` is what the next version is compared with; `waiting` a proposal
  // nothing has answered yet. A proposed goal is compared with as it was proposed.
  let last: GoalVersion | undefined, waiting: GoalVersion | undefined;
  const rows = goal.versions.map((v) => {
    const row = { v, what: what(v, last), before: last };
    if (!v.counts) return row;
    if (v.proposed) {
      row.what = last ? `Proposed: ${row.what}` : "Proposed";
      waiting = v;
      last ??= v;
      return row;
    }
    if (waiting) {
      if (same(v, waiting)) row.what = "Accepted";
      else if (same(v, last!) || (waiting.id === goal.id && v.status === "dropped" && v.title === waiting.title)) row.what = "Declined";
    }
    last = v;
    waiting = undefined;
    return row;
  });
  const latest = rows.findLast((r) => r.v.counts && !r.v.proposed);
  return (
    <section class="goal-section">
      <h4>History</h4>
      <ol class="goal-history">{rows.map((r) => (
        <li key={r.v.id} class={r.v.counts ? "" : "is-ignored"}>
          <time>{when(r.v.ts)}</time>
          <div>
            <p>
              <span>{r.what}</span>
              <span class="goal-who">{who(r.v)}</span>
              {!r.v.counts && <span class="goal-who">not applied</span>}
              {r === latest && r.before && !same(r.v, r.before) && (
                <button type="button" class="link-button" onClick={() => void save({
                  id: goal.id, title: r.before!.title, status: r.before!.status, why: `Undid: ${r.what}`,
                })}>Undo</button>
              )}
            </p>
            {/* The reason it was added is shown above the history already. */}
            {r.v.why && r.v.id !== goal.id && <small>{r.v.why}</small>}
          </div>
        </li>
      ))}</ol>
    </section>
  );
}

/** What an agent proposed, and the person's two answers. */
function Proposed({ goal, save }: { goal: Goal; save: Save<Change> }) {
  const p = goal.proposal!;
  return (
    <div class="goal-proposal">
      <p>
        <b>{p.added ? "Proposed" : `Proposed: ${what(p, goal)}`}</b>
        <span class="goal-who">{who(p)}</span>
      </p>
      {p.why && !(p.added && p.id === goal.id) && <small>{p.why}</small>}
      <div class="goal-actions">
        <button type="button" class="button primary" onClick={() => void save({ id: goal.id, answer: "accept" })}>Accept</button>
        <button type="button" class="button" onClick={() => void save({ id: goal.id, answer: "decline" })}>Decline</button>
      </div>
    </div>
  );
}

function GoalItem({ goal, save }: { goal: Goal; save: Save<Change> }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<"rename" | "sub" | null>(null);
  const done = (ok: boolean) => { if (ok) setForm(null); };
  return (
    <li class={`goal is-${goal.status}`}>
      <button type="button" class="goal-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`goal-status is-${goal.status}`}>{LABEL[goal.status]}</span>
        <span class="goal-title">{goal.title}</span>
        {goal.from && <span class="goal-from">from {goal.from}</span>}
        {goal.proposal && <span class="goal-proposed">{goal.proposal.added ? "Proposed" : "Change proposed"}</span>}
        {goal.total > 0 && <span class="goal-progress">{goal.done} of {goal.total} done</span>}
      </button>
      {open && (
        <div class="goal-detail">
          {goal.why && <p class="goal-why">{goal.why}</p>}
          {goal.proposal && <Proposed goal={goal} save={save} />}
          <div class="goal-actions">
            <Segmented label="Status" value={goal.status} options={STATUSES} onChange={(status) => void save({ id: goal.id, status })} />
            <button type="button" class="button" onClick={() => setForm("rename")}><Icon name="pencil" size={14} />Rename</button>
            <button type="button" class="button" onClick={() => setForm("sub")}><Icon name="plus" size={14} />Add sub-goal</button>
          </div>
          {form === "rename" && <TitleForm label="Title" submit="Save" initial={goal.title}
            onSave={(title) => void save({ id: goal.id, title }).then(done)} onCancel={() => setForm(null)} />}
          {form === "sub" && <TitleForm label="Sub-goal" submit="Add"
            onSave={(title) => void save({ parent: goal.id, title }).then(done)} onCancel={() => setForm(null)} />}
          <History goal={goal} save={save} />
          {goal.attempts.length > 0 && (
            <section class="goal-section">
              <h4>Attempts</h4>
              <ul class="goal-attempts">{goal.attempts.map((a) => (
                <li key={a.id}>
                  <OutcomeBadge status={a.status} />
                  <span>{a.intent || "No goal recorded"}</span>
                  <time>{when(a.ts)}</time>
                </li>
              ))}</ul>
            </section>
          )}
          <span class="goal-id">id {goal.id}</span>
        </div>
      )}
      {goal.subgoals.length > 0 && <ul class="goal-list">{goal.subgoals.map((s) => <GoalItem key={s.id} goal={s} save={save} />)}</ul>}
    </li>
  );
}

export function Goals() {
  const { data, error, save } = useLive<{ goals: Goal[] }, Change>("/api/goals");
  const [adding, setAdding] = useState(false);
  if (!data) return null;
  const { goals } = data;
  const live = goals.filter((g) => g.status !== "dropped");
  return (
    <section class="goals">
      <header class="goals-head">
        <h2>Goals</h2>
        {live.length > 0 && <span class="goal-progress">{live.filter((g) => g.status === "done").length} of {live.length} done</span>}
        {!adding && <button type="button" class="button" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add goal</button>}
      </header>
      <AbsorbNote what="goals" />
      {error && <p class="settings-status is-error">{error}</p>}
      {adding && <TitleForm label="Goal" submit="Add" onSave={(title) => void save({ title }).then((ok) => ok && setAdding(false))} onCancel={() => setAdding(false)} />}
      {!goals.length && !adding && (
        <p class="goals-empty">No goals yet.</p>
      )}
      {goals.length > 0 && <ul class="goal-list">{goals.map((g) => <GoalItem key={g.id} goal={g} save={save} />)}</ul>}
    </section>
  );
}
