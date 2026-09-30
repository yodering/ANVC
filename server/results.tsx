/**
 * The Results page: every value the project relies on, with its standing.
 *
 * One card per result: the value, its status, where it lives and whether
 * that file is as it was, what it depends on, how it was made, and why.
 * Grouped by the part of the project it belongs to, newest first, so a
 * part's history reads as a timeline: v6 over v4, locked for the paper.
 * Locking, unlocking and marking a result invalid are the person's, and
 * happen here or with anvc result.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { getJson, Icon, plural, Scope, send, when } from "./widgets";

type Status = "draft" | "current" | "locked" | "superseded" | "invalid";
type FileState = "same" | "changed" | "missing" | "unknown";
interface Check {
  source: { state: FileState; now: string | null } | null;
  depends: Array<{ path: string; state: FileState }>;
  derived: Array<{ id: string; name: string; status: string }>;
  stale: boolean;
}
interface Result {
  id: string; name: string; value: string; status: Status; by: "person" | "agent";
  proposed: { status: Status; why: string; ts: string } | null;
  part: string | null; ts: string; agent: string; why: string | null;
  source: { path: string; key?: string } | null; command: string | null; settings: Record<string, string>;
  replaces: string | null; replaced_by: string | null; used_in: string[]; after_the_fact: boolean;
  history: Array<{ ts: string; status: Status; by: "person" | "agent"; why: string | null; proposed: boolean }>;
  check: Check;
}
interface View { data: { mode: "off" | "results"; from: string }; everywhere: "off" | "results"; modes: Record<string, { label: string; what: string }>; results: Result[] }

const LABEL: Record<Status, string> = { draft: "Draft", current: "Current", locked: "Locked", superseded: "Superseded", invalid: "Invalid" };
const FILTERS: Array<[string, string]> = [["all", "All"], ["look", "Needs a look"], ["locked", "Locked"], ["current", "Current"], ["superseded", "Superseded"], ["invalid", "Invalid"]];
const day = (ts: string) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const needsLook = (r: Result) => Boolean(r.proposed) || ((r.status === "locked" || r.status === "current") && r.check.stale);

async function decide(body: object): Promise<View | null> {
  const r = await send("/api/results", body);
  return r.ok ? ((await r.json()) as View) : null;
}

function FileLine({ path, state, now }: { path: string; state: FileState; now?: string | null }) {
  const words = state === "same" ? "unchanged" : state === "changed" ? (now ? `changed, now ${now}` : "changed") : state === "missing" ? "not on this computer" : "not checked";
  return (
    <span class={`result-file is-${state}`}>
      <code>{path}</code>
      <span>{words}</span>
    </span>
  );
}

/** What changed in the settings from one version to the next: "lr 3e-4 → 1e-4". */
function changes(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.flatMap((k) => before[k] === after[k] ? []
    : before[k] === undefined ? [`${k}=${after[k]}`]
    : after[k] === undefined ? [`no ${k}`]
    : [`${k} ${before[k]} → ${after[k]}`]);
}

/** The versions a result belongs to, oldest first, followed through what each replaced. */
function lineage(r: Result, byId: Map<string, Result>): Result[] {
  const seen = new Set([r.id]);
  const older: Result[] = [];
  for (let at = r; at.replaces && byId.has(at.replaces) && !seen.has(at.replaces);) { at = byId.get(at.replaces)!; seen.add(at.id); older.unshift(at); }
  const newer: Result[] = [];
  for (let at = r; at.replaced_by && byId.has(at.replaced_by) && !seen.has(at.replaced_by);) { at = byId.get(at.replaced_by)!; seen.add(at.id); newer.push(at); }
  return [...older, r, ...newer];
}

function Lineage({ r, byId, onJump }: { r: Result; byId: Map<string, Result>; onJump: (id: string) => void }) {
  const line = lineage(r, byId);
  if (line.length < 2) return null;
  return (
    <div class="result-lineage">
      <h4>Versions</h4>
      <ol>{line.map((v, i) => (
        <li key={v.id} class={`${v.id === r.id ? "is-this " : ""}is-${v.status}`}>
          <span class="lineage-when">{day(v.ts)}</span>
          {v.id === r.id ? <b>{v.value}</b> : <button type="button" class="link-button" onClick={() => onJump(v.id)}>{v.value}</button>}
          <span class={`result-status is-${v.status}`}>{LABEL[v.status]}</span>
          {i > 0 && changes(line[i - 1]!.settings, v.settings).map((c) => <code key={c}>{c}</code>)}
          {v.why && <small>{v.why}</small>}
        </li>
      ))}</ol>
    </div>
  );
}

interface Moment { ts: string; r: Result; what: string; why: string | null; changed: string[] }

const DONE: Record<Status, string> = { draft: "Marked draft", current: "Marked current", locked: "Locked", superseded: "Marked superseded", invalid: "Marked invalid" };
const ASKED: Record<Status, string> = { draft: "draft", current: "current", locked: "locking it", superseded: "superseded", invalid: "marking it invalid" };

/** Everything that happened to the results, newest first: recorded, replaced, locked, marked invalid. */
function Timeline({ results, byId, onJump }: { results: Result[]; byId: Map<string, Result>; onJump: (id: string) => void }) {
  const moments: Moment[] = results.flatMap((r) => {
    const before = r.replaces ? byId.get(r.replaces) : undefined;
    const made: Moment = { ts: r.ts, r, what: before ? `Replaced ${before.value}` : "Recorded", why: r.history[0]?.why ?? r.why, changed: before ? changes(before.settings, r.settings) : [] };
    const later = r.history.slice(1).map((h): Moment => ({
      ts: h.ts, r, why: h.why, changed: [],
      what: h.proposed ? `Your agent proposed ${ASKED[h.status]}` : `${DONE[h.status]}${h.by === "person" ? " by you" : ""}`,
    }));
    return [made, ...later];
  }).sort((a, b) => b.ts.localeCompare(a.ts));
  const days = new Map<string, Moment[]>();
  for (const m of moments) (days.get(day(m.ts)) ?? days.set(day(m.ts), []).get(day(m.ts))!).push(m);
  return (
    <div class="results-timeline">
      {[...days].map(([date, list]) => (
        <section key={date}>
          <h2>{date}</h2>
          <ol>{list.map((m) => (
            <li key={m.ts + m.r.id + m.what}>
              <span class="timeline-time">{new Date(m.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
              <div>
                <p>
                  {m.r.part && <span class="timeline-part">{m.r.part}</span>}
                  <button type="button" class="link-button" onClick={() => onJump(m.r.id)}>{m.r.name} = {m.r.value}</button>
                  <span class="timeline-what">{m.what}</span>
                  {m.changed.map((c) => <code key={c}>{c}</code>)}
                </p>
                {m.why && <small>{m.why}</small>}
              </div>
            </li>
          ))}</ol>
        </section>
      ))}
    </div>
  );
}

function Card({ r, byId, onDecide, onJump }: { r: Result; byId: Map<string, Result>; onDecide: (body: object) => void; onJump: (id: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <article id={`result-${r.id}`} class={`result-card is-${r.status}${needsLook(r) ? " needs-look" : ""}`}>
      <header>
        <div>
          <h3>{r.name}</h3>
          <span class="result-when">{day(r.ts)}{r.after_the_fact ? " · recorded after the fact" : ""}</span>
        </div>
        <b class="result-value">{r.value}</b>
        <span class={`result-status is-${r.status}`}>{r.status === "locked" && <Icon name="lock" size={13} />}{LABEL[r.status]}</span>
      </header>
      {r.status === "locked" && (
        <p class="result-verdict">{r.check.stale ? "Locked, but something it depends on changed since. Worth a look before anyone re-runs it." : "Locked, and nothing it depends on changed."}</p>
      )}
      {r.status === "invalid" && <p class="result-verdict">Don't use this value.</p>}
      {r.status !== "locked" && r.status !== "invalid" && r.check.stale && <p class="result-verdict">Something it depends on changed since it was recorded.</p>}
      {r.why && <p class="result-why">{r.why}</p>}
      <dl class="result-facts">
        {r.source && (
          <>
            <dt>From</dt>
            <dd><FileLine path={`${r.source.path}${r.source.key ? ` → ${r.source.key}` : ""}`} state={r.check.source?.state ?? "unknown"} now={r.check.source?.now} /></dd>
          </>
        )}
        {r.check.depends.length > 0 && (
          <>
            <dt>Depends on</dt>
            <dd class="result-depends">{r.check.depends.map((d) => <FileLine key={d.path} path={d.path} state={d.state} />)}</dd>
          </>
        )}
        {r.check.derived.length > 0 && (
          <>
            <dt>Computed from</dt>
            <dd class="result-depends">{r.check.derived.map((d) => (
              <button key={d.id} type="button" class="link-button" onClick={() => onJump(d.id)}>{d.name} ({d.status})</button>
            ))}</dd>
          </>
        )}
        {r.command && (
          <>
            <dt>Made by</dt>
            <dd><code class="result-command">{r.command}</code></dd>
          </>
        )}
        {Object.keys(r.settings).length > 0 && (
          <>
            <dt>Settings</dt>
            <dd class="result-settings">{Object.entries(r.settings).map(([k, v]) => <code key={k}>{k}={v}</code>)}</dd>
          </>
        )}
        {r.used_in.length > 0 && (
          <>
            <dt>Used in</dt>
            <dd>{r.used_in.join(" · ")}</dd>
          </>
        )}
      </dl>
      <Lineage r={r} byId={byId} onJump={onJump} />
      {r.proposed && (
        <div class="result-proposal">
          <p>
            {r.proposed.status === "locked" ? "Your agent proposed locking this" : `Your agent proposed marking this ${LABEL[r.proposed.status].toLowerCase()}`}
            {r.proposed.why ? `: ${r.proposed.why}` : "."}
          </p>
          <button type="button" class="button primary" onClick={() => onDecide({ id: r.id, status: r.proposed!.status, why: r.proposed!.why })}>
            {r.proposed.status === "locked" ? "Lock" : `Mark ${LABEL[r.proposed.status].toLowerCase()}`}
          </button>
          <button type="button" class="button" onClick={() => onDecide({ id: r.id, status: r.status, why: "Kept as it was." })}>Keep as it is</button>
        </div>
      )}
      <footer class="result-actions">
        {r.status === "locked"
          ? <button type="button" class="button" onClick={() => onDecide({ id: r.id, status: "current", why: "Unlocked." })}>Unlock</button>
          : r.status !== "invalid" && r.proposed?.status !== "locked" && <button type="button" class="button" onClick={() => onDecide({ id: r.id, status: "locked", why: "Locked." })}><Icon name="lock" size={14} /> Lock</button>}
        {r.status !== "invalid" && !asking && <button type="button" class="button" onClick={() => setAsking(true)}>Mark invalid</button>}
        {r.status === "invalid" && <button type="button" class="button" onClick={() => onDecide({ id: r.id, status: "current", why: "Valid again." })}>Mark valid</button>}
        {asking && (
          <form class="result-invalid" onSubmit={(e) => { e.preventDefault(); onDecide({ id: r.id, status: "invalid", why: why.trim() || "Marked invalid." }); setAsking(false); }}>
            <input id={`why-${r.id}`} value={why} onInput={(e) => setWhy(e.currentTarget.value)} placeholder="Why is it wrong?" aria-label="Why is it wrong?" />
            <button type="submit" class="button primary">Mark invalid</button>
            <button type="button" class="button" onClick={() => setAsking(false)}>Cancel</button>
          </form>
        )}
        <span class="result-id">id {r.id}</span>
      </footer>
    </article>
  );
}

interface CheckRow { text: string; lines: number[]; state: "found" | "changed" | "unsure" | "missing"; reason: string; where?: string; by?: { command: string; step: string; ts: string }; evidence?: string }

const MARK = { found: "✓", changed: "⚠", unsure: "~", missing: "?" } as const;
const GROUPS = [
  ["changed", "Changed since", "What these came from changed after the document was written."],
  ["missing", "Not found", "Worked out by hand, from a run before ANVC, or from somewhere else. Ask your agent to record how it was made."],
  ["unsure", "Unsure", "Something printed it, but it could have been something else."],
  ["found", "Found", ""],
] as const;

const lineList = (lines: number[]) => `${lines.length > 1 ? "lines" : "line"} ${lines.slice(0, 4).join(", ")}${lines.length > 4 ? " …" : ""}`;

/** Every number in one of the project's documents, traced to the run or file it came from. */
function DocumentCheck() {
  const [documents, setDocuments] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [checked, setChecked] = useState<{ path: string; rows: CheckRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void getJson<{ documents?: string[] }>("/api/check").then((v) => {
      setDocuments(v.documents ?? []);
      setPath((p) => p || (v.documents?.includes("README.md") ? "README.md" : ""));
    }).catch(() => {});
  }, []);
  const run = async () => {
    setBusy(true); setError("");
    try {
      const v = await getJson<{ path?: string; rows?: CheckRow[]; error?: string }>(`/api/check?path=${encodeURIComponent(path.trim())}`);
      if (v.error || !v.rows) { setError(v.error ?? "Couldn't check it."); setChecked(null); }
      else setChecked({ path: v.path!, rows: v.rows });
    } catch { setError("Couldn't reach ANVC."); }
    setBusy(false);
  };
  // A number printed on three lines counts three times, as the reader sees it.
  const groups = GROUPS.map(([state, label, note]) => {
    const rows = checked?.rows.filter((r) => r.state === state) ?? [];
    return { state, label, note, rows, count: rows.reduce((n, r) => n + r.lines.length, 0) };
  }).filter((g) => g.rows.length > 0);
  const numbers = checked?.rows.reduce((n, r) => n + r.lines.length, 0) ?? 0;
  return (
    <section class="doc-check">
      <form class="doc-check-bar" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label for="doc-check-path">Check a document</label>
        <input id="doc-check-path" list="doc-check-documents" placeholder="README.md" value={path} onInput={(e) => setPath(e.currentTarget.value)} spellcheck={false} autocomplete="off" />
        <datalist id="doc-check-documents">{documents.map((d) => <option key={d} value={d} />)}</datalist>
        <button type="submit" class="button" disabled={!path.trim() || busy}>{busy ? "Checking…" : "Check"}</button>
        {checked && <button type="button" class="link-button" onClick={() => setChecked(null)}>Close</button>}
      </form>
      {error && <p class="settings-sub">{error}</p>}
      {checked && (
        <div class="doc-check-result">
          <p class="doc-check-summary">
            <b>{checked.path}</b>: {plural(numbers, "number")}.{" "}
            {groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(", ")}.
          </p>
          {groups.map(({ state, label, note, rows, count }) => (
            <details key={state} class={`doc-check-group is-${state}`} open={state !== "found"}>
              <summary><span class="doc-mark">{MARK[state]}</span>{label}<span class="doc-count">{count}</span></summary>
              {note && <p class="doc-note">{note}</p>}
              <ul>{rows.map((r) => (
                <li key={r.text + r.lines.join(",") + r.reason + (r.evidence ?? "")}>
                  <code class="doc-number">{r.text}</code>
                  <span class="doc-lines">{lineList(r.lines)}</span>
                  <div class="doc-source">
                    <span>{r.reason}{r.where ? <>: <code>{r.where}</code></> : null}</span>
                    {r.by && <span class="doc-by"><code title={r.by.command}>{r.by.step}</code><span>{when(r.by.ts)}</span></span>}
                    {r.evidence && <small>{r.evidence}</small>}
                  </div>
                </li>
              ))}</ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

interface PrintedRow { key: string; ts: string; what: string; note: string }

/** One list of where a searched number turned up: when, what, and a line of context. */
function Printed({ title, rows }: { title: string; rows: PrintedRow[] }) {
  if (!rows.length) return null;
  return (
    <section class="results-printed">
      <h3>{title}</h3>
      <ul>{rows.map((r) => <li key={r.key}><span>{when(r.ts)}</span><code>{r.what}</code><small>{r.note}</small></li>)}</ul>
    </section>
  );
}

/** A command that printed the number, and the line it printed. */
const printed = (o: { ts: string; command: string; line: string }): PrintedRow => ({ key: o.ts + o.command, ts: o.ts, what: o.command, note: o.line });

export function ResultsPage() {
  const [view, setView] = useState<View | null>(null);
  const [filter, setFilter] = useState("all");
  const [mode, setMode] = useState<"parts" | "timeline">("parts");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{
    results: Result[];
    files: Array<{ path: string; key: string; found: string; command: string; ts: string; changed: boolean }>;
    outputs: Array<{ ts: string; command: string; line: string }>;
    reads: Array<{ ts: string; command: string; line: string }>;
    elsewhere: Array<{ path: string; key: string; found: string; modified: string; before?: { command: string; ts: string }; commit?: string }>;
  } | null>(null);
  useEffect(() => { void getJson<View>("/api/results").then(setView).catch(() => {}); }, []);
  // A number or a name, looked up as it is typed.
  useEffect(() => {
    if (!query.trim()) { setFound(null); return; }
    const t = setTimeout(() => {
      void getJson(`/api/whence?q=${encodeURIComponent(query.trim())}`).then(setFound).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const byId = useMemo(() => new Map((view?.results ?? []).map((r) => [r.id, r])), [view]);
  if (!view) return <p class="map-empty">Reading results…</p>;

  const onDecide = async (body: object) => { const next = await decide(body); if (next) setView(next); };
  const onJump = (id: string) => {
    setFilter("all"); setQuery(""); setMode("parts");
    requestAnimationFrame(() => document.getElementById(`result-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  if (view.data.mode === "off") {
    return (
      <div class="results">
        <div class="folder-off">
          <p><b>Keeping track of results is off for this project.</b> Your agent can't record results here.</p>
          <button type="button" class="button" onClick={() => void decide({ mode: "results" }).then((v) => v && setView(v))}>Turn on</button>
        </div>
      </div>
    );
  }

  const count = (key: string) => view.results.filter((r) => key === "all" || (key === "look" ? needsLook(r) : r.status === key)).length;
  const listed = (found ? found.results : view.results).filter((r) => filter === "all" || (filter === "look" ? needsLook(r) : r.status === filter));
  const parts = new Map<string, Result[]>();
  for (const r of listed) (parts.get(r.part ?? "") ?? parts.set(r.part ?? "", []).get(r.part ?? "")!).push(r);

  return (
    <div class="results">
      <div class="filterbar results-bar">
        <div class="filter-tabs" role="group" aria-label="Filter by status">
          {FILTERS.filter(([key]) => key === "all" || count(key) > 0).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} class={`${filter === key ? "current" : ""}${key === "look" ? " tab-missing" : ""}`} onClick={() => setFilter(key)}>
              {label}<span>{count(key)}</span>
            </button>
          ))}
        </div>
        {view.results.length > 0 && (
          <div class="filter-tabs results-mode" role="group" aria-label="Show">
            <button type="button" aria-pressed={mode === "parts"} class={mode === "parts" ? "current" : ""} onClick={() => setMode("parts")}>By part</button>
            <button type="button" aria-pressed={mode === "timeline"} class={mode === "timeline" ? "current" : ""} onClick={() => setMode("timeline")}>Timeline</button>
          </div>
        )}
        <label class="search">
          <Icon name="search" />
          <input id="results-search" type="search" aria-label="Find a number or a result" placeholder="Find a number or a result…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      </div>
      <DocumentCheck />
      {!view.results.length && !found && (
        <div class="results-empty">
          <h2>No results yet</h2>
          <p>When your agent produces a number you'll rely on, it records it here with where it came from. You can also ask it to: "record that as a result".</p>
        </div>
      )}
      {found && (
        <>
          <Printed title="In files commands wrote" rows={found.files.map((f) => ({
            key: f.path + f.key, ts: f.ts, what: `${f.path} → ${f.key} = ${f.found}${f.changed ? "  (changed since)" : ""}`, note: `written by ${f.command}`,
          }))} />
          <Printed title="Printed by, oldest first" rows={found.outputs.map(printed)} />
          <Printed title="In other files" rows={found.elsewhere.map((f) => ({
            key: f.path + f.key, ts: f.modified, what: `${f.path} → ${f.key} = ${f.found}`,
            note: `${f.before ? `changed before ${f.before.command} finished` : "no command in the log named it"}${f.commit ? ` · in commit ${f.commit}` : ""}`,
          }))} />
          <Printed title="Repeated by" rows={found.reads.map(printed)} />
        </>
      )}
      {found && !found.results.length && !found.outputs.length && !found.reads.length && !found.files.length && !found.elsewhere.length && <p class="settings-sub">Nothing recorded holds "{query}", and no command here printed it.</p>}
      {mode === "timeline" && !found && <Timeline results={listed} byId={byId} onJump={onJump} />}
      {(mode === "parts" || found) && [...parts.entries()].sort(([a], [b]) => (a ? b ? a.localeCompare(b) : -1 : 1)).map(([part, list]) => (
        <section key={part} class="results-part">
          {parts.size > 1 || part ? <h2>{part || "Other"}</h2> : null}
          {list.map((r) => <Card key={r.id} r={r} byId={byId} onDecide={(b) => void onDecide(b)} onJump={onJump} />)}
        </section>
      ))}
    </div>
  );
}

/** The Settings section: whether to keep track of results, here or everywhere. */
export function DataSettings() {
  const [view, setView] = useState<View | null>(null);
  const [scope, setScope] = useState<"project" | "everywhere" | null>(null);
  useEffect(() => {
    void getJson<View>("/api/results").then((v) => {
      setView(v);
      setScope(v.data.from === "project" ? "project" : "everywhere");
    }).catch(() => {});
  }, []);
  if (!view || !scope) return null;
  const current = scope === "project" ? view.data.mode : view.everywhere;
  const save = async (mode: string) => { const next = await decide({ mode, scope }); if (next) setView(next); };
  return (
    <section class="assist">
      <h3>Results</h3>
      <p class="settings-sub">Numbers your project relies on, with where they came from and whether they can still be trusted.</p>
      <Scope scope={scope} own={view.data.from === "project"} onScope={setScope}
        onFollow={() => void decide({ scope: "follow" }).then((v) => { if (v) { setView(v); setScope("everywhere"); } })} />
      <div class="presets">
        {Object.entries(view.modes).map(([key, m]) => (
          <button key={key} type="button" class={`preset${current === key ? " is-on" : ""}`} onClick={() => void save(key)}>
            <b>{m.label}{key === "results" && <span>Recommended</span>}</b>
            <span>{m.what}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
