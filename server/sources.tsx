/**
 * The Sources page: the pages, searches and documents agents read here.
 *
 * Each row names the source, when it was read, in which session, and the
 * attempts and results linked to it: recorded in that session, or naming its
 * URL or path. Opening one fetches the text that was kept. Reads only; what
 * is kept is decided by the Sources field in Settings.
 */
import { useEffect, useState } from "preact/hooks";
import { getJson, Icon, OutcomeBadge, when } from "./widgets";
import "./sources.css";

type Kind = "page" | "search" | "document";
interface Link { id: string; kind: "attempt" | "result"; title: string; status: string; how: "session" | "named" }
interface Row {
  id: string; kind: Kind; ts: string; session_id: string | null; agent_name: string;
  url: string | null; path: string | null; query: string | null; title: string | null; asked: string | null;
  chars: number | null; links: Link[];
}
interface View { on: boolean; total: number; sources: Row[] }

const KIND: Record<Kind, string> = { page: "Page", search: "Search", document: "Document" };
const nameOf = (s: Row) => (s.kind === "search" ? `“${s.query ?? ""}”` : s.url ?? s.path ?? "");
/** What a row is called: its title, a document's file name, or its URL or query. */
const label = (s: Row) => s.title ?? (s.path ? s.path.split(/[\\/]/).at(-1)! : nameOf(s));

function Kept({ id, pdf }: { id: string; pdf: boolean }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void getJson<{ source?: { text: string | null } }>(`/api/sources?id=${encodeURIComponent(id)}`)
      .then((v) => setText(v.source?.text ?? null)).catch(() => setText(null));
  }, [id]);
  if (text === undefined) return <p class="source-note">Reading…</p>;
  if (text === null) return <p class="source-note">No text was kept.{pdf && " Keeping a PDF's text needs pdftotext."}</p>;
  return <pre class="source-text">{text}</pre>;
}

function SourceRow({ s }: { s: Row }) {
  const [open, setOpen] = useState(false);
  return (
    <details class="source-item" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span class={`source-kind is-${s.kind}`}>{KIND[s.kind]}</span>
        <span class="source-name">{label(s)}</span>
        <span class="source-when">{when(s.ts)}</span>
        <span class="source-meta">
          Session <code>{s.session_id?.slice(0, 8) ?? "unknown"}</code> · {s.agent_name}
          {s.chars === null && " · no text kept"}
        </span>
        {s.links.length > 0 && (
          <ul class="source-links">
            {s.links.map((l) => (
              <li key={l.id}>
                {l.kind === "result" ? <span class="source-result">Result</span> : <OutcomeBadge status={l.status} />}
                <span>{l.title || "No goal"}</span>
                <small>{l.how === "session" ? "same session" : "names it"}</small>
              </li>
            ))}
          </ul>
        )}
      </summary>
      <div class="source-body">
        {label(s) !== nameOf(s) && <p class="source-where"><code>{nameOf(s)}</code></p>}
        {/^https?:\/\//i.test(s.url ?? "") && (
          <p class="source-where">
            <a href={s.url!} target="_blank" rel="noopener noreferrer">Open the page <Icon name="external-link" size={13} /></a>
          </p>
        )}
        {s.asked && <p class="source-asked"><b>Asked</b> {s.asked}</p>}
        {open && <Kept id={s.id} pdf={Boolean(s.path?.toLowerCase().endsWith(".pdf"))} />}
      </div>
    </details>
  );
}

export function SourcesPage() {
  const [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState("");
  // Searched as it is typed, like the Results page.
  useEffect(() => {
    const t = setTimeout(() => {
      void getJson<View>(`/api/sources?q=${encodeURIComponent(query.trim())}`).then(setView).catch(() => {});
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query]);
  if (!view) return <p class="map-empty">Reading sources…</p>;

  return (
    <div class="sources">
      {view.total > 0 && (
        <div class="filterbar sources-bar">
          <label class="search">
            <Icon name="search" />
            <input type="search" aria-label="Search sources" placeholder="Search sources…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
        </div>
      )}
      {!view.on && <p class="source-note">Sources are off here. Turn them on in Settings, under Raw log.</p>}
      {view.on && !view.total && (
        <div class="results-empty">
          <h2>No sources yet</h2>
          <p>The pages your agent fetches, its web searches, and the papers and notes it reads outside the project are kept here, with the text it got back.</p>
        </div>
      )}
      {view.total > 0 && !view.sources.length && <p class="source-note">No source holds "{query}".</p>}
      {view.sources.length > 0 && <div class="source-list">{view.sources.map((s) => <SourceRow key={s.id} s={s} />)}</div>}
    </div>
  );
}
