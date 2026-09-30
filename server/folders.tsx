/**
 * Where ANVC is on, and the switch for each place.
 *
 * Installed once, ANVC runs in every repository its agents open. The switch
 * for the folder in view sits at the top of every page, and the Folders page
 * lists every folder it has run in, so turning several off doesn't mean
 * opening each one. Below those it lists the other git repositories on this
 * computer, with setup for each where ANVC is installed one project at a
 * time (protocol/found.ts).
 */
import { useEffect, useState } from "preact/hooks";
import { Copy, CopyButton, getJson, Icon, send } from "./widgets";

export interface FolderView { repo: string; on: boolean; seen: string }
interface FoldersData { current: string; folders: FolderView[]; local: boolean }

async function post(body: object): Promise<FoldersData | null> {
  const r = await send("/api/folders", body);
  return r.ok ? ((await r.json()) as FoldersData) : null;
}

/** The folder list, shared by the switch in the top bar and the Folders page. */
export function useFolders() {
  const [data, setData] = useState<FoldersData | null>(null);
  const load = () => getJson<FoldersData>("/api/folders").then(setData).catch(() => {});
  useEffect(() => {
    void load();
    // Another tab or `anvc off` in a terminal can change it.
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);
  const set = async (repo: string, on: boolean) => {
    if (data) setData({ ...data, folders: data.folders.map((f) => (f.repo === repo ? { ...f, on } : f)) });
    const next = await post({ repo, on });
    if (next) setData(next);
  };
  // Opening another folder points the server at it; the page reloads so every
  // view reads the new folder from scratch.
  const open = async (repo: string) => {
    if (await post({ repo, open: true })) location.reload();
  };
  const here = data?.folders.find((f) => f.repo === data.current) ?? null;
  return { data, here, set, open };
}

const name = (repo: string) => repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;

/** On and off as words, with the state in colour: a switch that reads out loud. */
export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      class={`folder-toggle${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span class="folder-toggle-track"><span class="folder-toggle-knob" /></span>
      <span>{on ? "On" : "Off"}</span>
    </button>
  );
}

/** The switch for the folder in view, in the top bar. */
export function FolderSwitch({ folders }: { folders: ReturnType<typeof useFolders> }) {
  const { here, set, data } = folders;
  if (!here) return null;
  return (
    <div class="folder-switch">
      {data?.local && <span class="local-tag" title="Everything ANVC keeps here stays on this computer. Change it in Settings.">Local only</span>}
      <span>ANVC for this project</span>
      <Toggle on={here.on} label="ANVC for this project" onChange={(on) => void set(here.repo, on)} />
    </div>
  );
}

/** Said above the work log when this folder is off, with the way back. */
export function OffBanner({ folders }: { folders: ReturnType<typeof useFolders> }) {
  const { here, set } = folders;
  if (!here || here.on) return null;
  return (
    <div class="folder-off" role="status">
      <p>
        <b>ANVC is off for this project.</b> Nothing is saved here or shown to agents.
      </p>
      <button class="button" onClick={() => void set(here.repo, true)}>Turn on</button>
    </div>
  );
}

interface FoundRepo { repo: string; on: boolean; state: "everywhere" | "project" | "none"; command: string }
/** What /api/folders/found answers: see FoundView in protocol/found.ts. */
interface FoundData {
  everywhere: string[]; agents: string[]; setup: boolean; searched: string[]; stopped: boolean;
  found: FoundRepo[]; commands: { everywhere: string; remove: string };
}
/** What a change is to: one repository, or ANVC for every project. */
type Target = { repo: string } | { everywhere: "install" | "remove" };
interface Done { key: string; title: string; output: string }

/** Names joined the way they're said: "Claude Code, Codex and Cursor". */
const said = (names: string[], type: Intl.ListFormatType = "conjunction") => new Intl.ListFormat("en-GB", { type }).format(names);

const OFFLINE = "Couldn't reach the ANVC server";

/** Repositories ANVC hasn't run in, read once when the page opens: the search can take a second or two. */
function useFound() {
  const [data, setData] = useState<FoundData | null>(null);
  const [error, setError] = useState("");
  /** Takes the list from a response, or its error. True when it was the list. */
  const answer = async (r: Promise<Response>) => {
    const out = await r.then((res) => res.json()).catch(() => ({ error: OFFLINE }));
    if (out.error) { setError(out.error); return false; }
    setError("");
    setData(out as FoundData);
    return true;
  };
  const load = () => answer(fetch("/api/folders/found"));
  useEffect(() => { void load(); }, []);
  const set = (repo: string, on: boolean) => {
    if (data) setData({ ...data, found: data.found.map((f) => (f.repo === repo ? { ...f, on } : f)) });
    return answer(send("/api/folders/found", { repo, on }));
  };
  const add = (folder: string) => answer(send("/api/folders/found", { add: folder }));
  return { data, error, load, set, add };
}

/**
 * What a change will do, from setup's own dry run, and the button that does
 * it. Nothing changes until that button is pressed.
 */
function Preview({ target, ask, action, onDone, onCancel }: {
  target: Target; ask: string; action: string; onDone: (output: string) => void; onCancel: () => void;
}) {
  const [plan, setPlan] = useState<{ changes?: string[]; kept?: string[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams(target as Record<string, string>).toString();
  useEffect(() => {
    void getJson(`/api/folders/setup?${query}`).then(setPlan).catch(() => setPlan({ error: OFFLINE }));
  }, [query]);
  const run = async () => {
    setBusy(true);
    const out = await (await send("/api/folders/setup", target)).json().catch(() => ({ error: OFFLINE }));
    setBusy(false);
    if (out.error) setPlan({ ...plan, error: out.error }); else onDone(out.output ?? "");
  };
  const changes = plan?.changes ?? [];
  const removing = "everywhere" in target && target.everywhere === "remove";
  return (
    <div class="folder-plan" aria-live="polite">
      {!plan ? <p>Checking what this changes…</p> : plan.error ? <p class="is-error">{plan.error}</p> : (
        <>
          <p>{ask} {!changes.length ? "There's nothing to change." : removing ? "This takes out:" : "This changes:"}</p>
          {changes.length > 0 && (
            <ul>
              {changes.map((c) => {
                // Setup lists "where: what"; uninstall says it in one phrase.
                const at = c.indexOf(": ");
                return <li key={c}>{at > 0 ? <><code>{c.slice(0, at)}</code> {c.slice(at + 2)}</> : c}</li>;
              })}
            </ul>
          )}
          {plan.kept?.map((k) => <p key={k} class="folder-kept">Kept: {k}</p>)}
        </>
      )}
      <div>
        {changes.length > 0 && !plan?.error && (
          <button class="button primary" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : action}</button>
        )}
        <button class="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** What setup printed once it's done: what to do next is in there, such as registering an MCP server. */
function Result({ done, at }: { done: Done | null; at: string }) {
  if (done?.key !== at) return null;
  return (
    <details class="folder-result" open>
      <summary>{done.title}</summary>
      <pre>{done.output}</pre>
    </details>
  );
}

/** How ANVC is installed, and the one control that installs it for every project or takes that out. */
function EveryProject({ data, done, onDone }: { data: FoundData; done: Done | null; onDone: (d: Done) => void }) {
  const [asking, setAsking] = useState(false);
  const on = data.everywhere.length > 0;
  return (
    <section class="folder-every">
      <div class="folder-every-head">
        <p>{on ? `ANVC runs in every project ${said(data.everywhere, "disjunction")} opens.` : "ANVC is set up one project at a time."}</p>
        {!asking && (on || data.setup) && (
          <button class="button" onClick={() => setAsking(true)}>{on ? "Remove" : "Install for every project"}</button>
        )}
      </div>
      {!on && !data.setup && (
        <>
          <p>To install it for every project, run this in your ANVC folder:</p>
          <Copy text={data.commands.everywhere} />
        </>
      )}
      {asking && (
        <Preview
          target={{ everywhere: on ? "remove" : "install" }}
          ask={on ? "Remove ANVC from every project?" : `Install ANVC in every project ${said(data.agents, "disjunction")} opens?`}
          action={on ? "Remove" : "Install"}
          onCancel={() => setAsking(false)}
          onDone={(output) => { setAsking(false); onDone({ key: "everywhere", title: on ? "ANVC is removed from every project" : "ANVC is installed for every project", output }); }}
        />
      )}
      <Result done={done} at="everywhere" />
    </section>
  );
}

/** Repositories ANVC hasn't run in: a switch where it would run, and setup where it wouldn't yet. */
function Found({ found, done, onDone }: { found: ReturnType<typeof useFound>; done: Done | null; onDone: (d: Done) => void }) {
  const { data, set, add } = found;
  const [typed, setTyped] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  if (!data) return null;
  const copy = !data.setup && data.found.some((f) => f.state === "none");
  return (
    <section class="folder-found">
      <h3>Other repositories</h3>
      <p class="folder-sub">
        {data.searched.length ? `Looked in ${said(data.searched)}.` : "Add a folder to look in."}
        {data.stopped && " Stopped early, so some may be missing."}
        {copy && " To set one up, run its command in your ANVC folder."}
      </p>
      {data.found.length > 0 && (
        <ul class="folder-list">
          {data.found.map((f) => (
            <li key={f.repo} class={`folder-row${f.state !== "none" && !f.on ? " is-off" : ""}`}>
              <Icon name="folder" size={20} />
              <div class="folder-name">
                <strong>{name(f.repo)}</strong>
                <small>{f.repo}</small>
                {f.state === "none" && !data.setup && <code>{f.command}</code>}
              </div>
              {f.state !== "none"
                ? <Toggle on={f.on} label={`ANVC for ${name(f.repo)}`} onChange={(on) => void set(f.repo, on)} />
                : !data.setup ? <CopyButton text={f.command} />
                : asking !== f.repo && <button class="button" onClick={() => setAsking(f.repo)}>Set up</button>}
              {asking === f.repo && (
                <Preview
                  target={{ repo: f.repo }}
                  ask={`Set up ANVC in ${name(f.repo)} for ${said(data.agents)}?`}
                  action="Set up"
                  onCancel={() => setAsking(null)}
                  onDone={(output) => { setAsking(null); onDone({ key: f.repo, title: `${name(f.repo)} is set up`, output }); }}
                />
              )}
              <Result done={done} at={f.repo} />
            </li>
          ))}
        </ul>
      )}
      <form class="folder-add" onSubmit={(e) => { e.preventDefault(); void add(typed).then((ok) => ok && setTyped("")); }}>
        <input value={typed} placeholder="~/code" aria-label="Folder to look in" onInput={(e) => setTyped(e.currentTarget.value)} />
        <button type="submit" class="button" disabled={!typed.trim()}>Add folder</button>
      </form>
    </section>
  );
}

/**
 * Every folder ANVC has run in, each with its switch, then the other git
 * repositories on this computer, with what each needs for ANVC to run there.
 */
export function FoldersPage({ folders }: { folders: ReturnType<typeof useFolders> }) {
  const { data, set, open } = folders;
  const found = useFound();
  const [done, setDone] = useState<Done | null>(null);
  const finished = (d: Done) => { setDone(d); void found.load(); };
  if (!data) return <p class="map-empty">Loading folders…</p>;
  return (
    <div class="folders">
      {found.data && <EveryProject data={found.data} done={done} onDone={finished} />}
      <ul class="folder-list">
        {data.folders.map((f) => (
          <li key={f.repo} class={`folder-row${f.on ? "" : " is-off"}`}>
            <Icon name="folder" size={20} />
            <div class="folder-name">
              <strong>{name(f.repo)}</strong>
              <small>{f.repo}</small>
            </div>
            <small class="folder-seen">{f.repo === data.current ? "Open now" : `Used ${f.seen.slice(0, 10)}`}</small>
            {f.repo !== data.current && (
              <button class="button" onClick={() => void open(f.repo)}>Open</button>
            )}
            <Toggle on={f.on} label={`ANVC for ${name(f.repo)}`} onChange={(next) => void set(f.repo, next)} />
          </li>
        ))}
      </ul>
      {!found.data && !found.error && <p class="folder-sub folder-looking">Looking for other repositories…</p>}
      <Found found={found} done={done} onDone={finished} />
      {found.error && <p class="settings-status is-error" role="status">{found.error}</p>}
    </div>
  );
}
