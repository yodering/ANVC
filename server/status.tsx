/**
 * Status: what's in progress now, what was done recently and where it
 * stands, and what's up next (protocol/status.ts). The person adds, edits,
 * moves and drops the items in Up next; the other two lists are read from
 * the capture log and the records, and change on their own.
 */
import { useState } from "preact/hooks";
import type { Finished, Item, Status as StatusView, Working } from "../protocol/status";
import { Icon, TitleForm, useLive, type Save } from "./widgets";
import "./status.css";

const STANDS: Record<NonNullable<Finished["stands"]>, string> = {
  uncommitted: "Not committed", local: "Only on this computer", main: "In main", pushed: "Pushed", released: "Released", unknown: "Commit not found",
};

/** "14:02" today, "Yesterday", or "28 Sep". */
function day(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

type Change = { id?: string; title?: string; goal?: string | null; state?: Item["state"]; move?: "up" | "down" };

function ItemForm({ submit, item, goals, onSave, onCancel }: {
  submit: string; item?: Item; goals: Record<string, string>; onSave: (title: string, goal: string | null) => void; onCancel: () => void;
}) {
  const [goal, setGoal] = useState(item?.goal ?? "");
  return (
    <TitleForm label="Item" placeholder="What's next" submit={submit} initial={item?.title} changed={goal !== (item?.goal ?? "")}
      onSave={(title) => onSave(title, goal || null)} onCancel={onCancel}>
      {Object.keys(goals).length > 0 && (
        <select value={goal} onChange={(e) => setGoal(e.currentTarget.value)} aria-label="Goal">
          <option value="">No goal</option>
          {Object.entries(goals).map(([id, t]) => <option key={id} value={id}>{t}</option>)}
        </select>
      )}
    </TitleForm>
  );
}

/** An item's title, quoted when it was fetched from a remote, and the goal it's for. */
function Title({ item, goals }: { item: Pick<Item, "title" | "goal" | "from">; goals: Record<string, string> }) {
  return (
    <span class="status-title">
      {item.from ? `“${item.title}”` : item.title}
      {item.goal && goals[item.goal] && <small>for {goals[item.goal]}</small>}
    </span>
  );
}

function NowRow({ w, goals }: { w: Working; goals: Record<string, string> }) {
  const who = w.subagent ? `${w.subagent} subagent` : w.agent;
  return (
    <li class="status-row">
      <span class={`status-title${w.title ? "" : " is-empty"}`}>
        {w.source === "prompt" || w.from ? `“${w.title}”` : w.title ?? "No task stated"}
        {w.goal && goals[w.goal] && <small>for {goals[w.goal]}</small>}
      </span>
      <span class="status-meta">{w.from ? `From ${w.from}` : who}{!w.live && w.agent !== "You" ? ", not running" : ""}</span>
      <time class="status-meta" dateTime={w.since}>since {day(w.since)}</time>
    </li>
  );
}

function DoneRow({ f, goals }: { f: Finished; goals: Record<string, string> }) {
  return (
    <li class="status-row">
      <Title item={f} goals={goals} />
      <time class="status-meta" dateTime={f.ts}>{day(f.ts)}</time>
      <span class={`status-stand is-${f.stands ?? "none"}`} title={f.commit ?? undefined}>
        {f.stands === "released" && f.tag ? `Released in ${f.tag}` : f.stands ? STANDS[f.stands] : ""}
      </span>
    </li>
  );
}

function NextRow({ item, first, last, goals, save }: { item: Item; first: boolean; last: boolean; goals: Record<string, string>; save: Save<Change> }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li class="status-row is-editing">
        <ItemForm submit="Save" item={item} goals={goals} onCancel={() => setEditing(false)}
          onSave={(title, goal) => void save({ id: item.id, title, goal }).then((ok) => ok && setEditing(false))} />
      </li>
    );
  }
  return (
    <li class="status-row">
      <Title item={item} goals={goals} />
      <span class="status-actions">
        <button type="button" class="icon-button" aria-label="Move up" title="Move up" disabled={first} onClick={() => void save({ id: item.id, move: "up" })}><Icon name="chevron-up" /></button>
        <button type="button" class="icon-button" aria-label="Move down" title="Move down" disabled={last} onClick={() => void save({ id: item.id, move: "down" })}><Icon name="chevron-down" /></button>
        <button type="button" class="icon-button" aria-label="Edit" title="Edit" onClick={() => setEditing(true)}><Icon name="pencil" /></button>
        <button type="button" class="icon-button" aria-label="Drop" title="Drop" onClick={() => void save({ id: item.id, state: "dropped" })}><Icon name="close" /></button>
      </span>
    </li>
  );
}

export function Status() {
  // Sessions start and stop too, so it's read again like the goals.
  const { data: status, error, save } = useLive<StatusView, Change>("/api/status");
  const [adding, setAdding] = useState(false);
  if (!status) return null;
  const { now, done, next, goals } = status;
  return (
    <section class="status">
      <h2>Status</h2>
      {error && <p class="settings-status is-error">{error}</p>}
      <div class="status-list">
        <h3>In progress</h3>
        {now.length ? <ul>{now.map((w, i) => <NowRow key={`${w.session}-${w.item ?? w.since}-${i}`} w={w} goals={goals} />)}</ul>
          : <p class="status-empty">Nothing's running.</p>}
      </div>
      <div class="status-list">
        <h3>Done recently</h3>
        {done.length ? <ul>{done.map((f) => <DoneRow key={f.id} f={f} goals={goals} />)}</ul>
          : <p class="status-empty">Nothing finished yet.</p>}
      </div>
      <div class="status-list">
        <header>
          <h3>Up next</h3>
          {!adding && <button type="button" class="button" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add</button>}
        </header>
        {adding && <ItemForm submit="Add" goals={goals} onCancel={() => setAdding(false)}
          onSave={(title, goal) => void save({ title, goal }).then((ok) => ok && setAdding(false))} />}
        {next.length ? (
          <ul>{next.map((item, i) => <NextRow key={item.id} item={item} first={i === 0} last={i === next.length - 1} goals={goals} save={save} />)}</ul>
        ) : !adding && <p class="status-empty">Nothing queued.</p>}
      </div>
    </section>
  );
}
