/**
 * Each agent's MCP servers, plugins, skills and hooks, and when to use them.
 *
 * Read from the agents' own config files (protocol/tools.ts); nothing here
 * switches a tool on or off. The one thing a person writes is a note saying
 * when to use a tool, which every agent here is told when a session starts.
 */
import { useEffect, useState } from "preact/hooks";
import type { AgentTools, Tool, ToolKind, ToolNote } from "../protocol/tools";
import { getJson, send } from "./widgets";

interface ToolsView { agents: AgentTools[]; notes: ToolNote[]; error?: string }

const KINDS: Array<[ToolKind, string]> = [["mcp", "MCP servers"], ["plugin", "Plugins"], ["skill", "Skills"], ["command", "Commands"], ["hook", "Hooks"]];
const STATE = { on: "On", off: "Off", unknown: "Unknown" } as const;

/** Why the files can't say whether a tool is on, where the reason is known. */
function unknownWhy(agent: string, t: Tool): string {
  if (agent === "cursor" && t.kind === "mcp") return "Cursor keeps this switch in its own settings.";
  if (agent === "codex" && t.kind === "hook") return "Codex runs a hook once you've reviewed it with /hooks.";
  if (agent === "claude-code" && t.kind === "mcp") return "Claude Code asks before it runs a server from .mcp.json.";
  return "The config files don't say.";
}

const whereLabel = (where: string) =>
  where === "every project" ? "Every project" : where === "this project" ? "This project" : `${where} plugin`;

/** What the row's name shows on hover: how it runs, what it's given, where it's set. */
function details(t: Tool): string {
  return [
    t.events?.length ? `On ${t.events.join(", ")}` : "",
    t.runs ? `Runs ${t.runs}` : "",
    t.env?.length ? `Environment: ${t.env.join(", ")}` : "",
    t.headers?.length ? `Headers: ${t.headers.join(", ")}` : "",
    t.file,
  ].filter(Boolean).join("\n");
}

/** A tool's note, edited in place; open at once when there's none yet. */
function Note({ tool, note, onSave, onDone }: {
  tool: string; note: ToolNote | undefined;
  onSave: (tool: string, when: string) => Promise<string | null>; onDone: () => void;
}) {
  const [text, setText] = useState<string | null>(note ? null : "");
  const [error, setError] = useState("");
  const close = () => { setText(note ? null : ""); setError(""); if (!note) onDone(); };
  const save = async () => {
    const failed = await onSave(tool, text ?? "");
    if (failed) setError(failed);
    else { setError(""); onDone(); }
  };
  if (text === null) {
    return (
      <button type="button" class="tool-note" title={note!.remote ? `From ${note!.remote}` : "Edit"} onClick={() => setText(note!.when)}>
        {note!.remote ? <>“{note!.when}” <small>from {note!.remote}</small></> : note!.when}
      </button>
    );
  }
  return (
    <form class="tool-note-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input
        aria-label={`When to use ${tool}`} placeholder="When to use it" maxLength={300} value={text} autoFocus
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Escape") close(); }}
      />
      <button type="submit" class="button primary" disabled={!text.trim()}>Save</button>
      <button type="button" class="button" onClick={close}>Cancel</button>
      {error && <span class="tool-note-error" role="alert">{error}</span>}
    </form>
  );
}

export function Tools() {
  const [view, setView] = useState<ToolsView | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    void getJson<ToolsView>("/api/tools").then((v) => (v.error ? setError(v.error) : setView(v))).catch(() => setError("Couldn't load tools."));
  }, []);

  const saveNote = async (tool: string, when: string): Promise<string | null> => {
    try {
      const out = await (await send("/api/tools", { tool, when })).json() as ToolsView;
      if (out.error) return out.error;
      setView(out);
      return null;
    } catch { return "Couldn't save."; }
  };

  if (!view) return error ? <section class="tools-section"><h2>Tools</h2><p class="tools-empty">{error}</p></section> : null;
  const noteFor = new Map(view.notes.map((n) => [n.tool.toLowerCase(), n]));
  const named = new Set(view.agents.flatMap((a) => a.tools.map((t) => t.name.toLowerCase())));
  const others = view.notes.filter((n) => !named.has(n.tool.toLowerCase()));
  const keyOf = (agent: string, t: Tool) => `${agent}:${t.kind}:${t.name}:${t.where}:${t.file}`;

  return (
    <section class="tools-section">
      <h2>Tools</h2>
      <p class="tools-sub">Click a tool to add a note.</p>
      <div class="tools-grid">
        {view.agents.map((a) => (
          <div class="tools-agent" key={a.agent}>
            <h3>{a.name}</h3>
            {!a.tools.length && <p class="tools-empty">None found.</p>}
            {KINDS.map(([kind, label]) => {
              const tools = a.tools.filter((t) => t.kind === kind);
              if (!tools.length) return null;
              const open = tools.find((t) => keyOf(a.agent, t) === picked);
              const noted = tools.filter((t) => noteFor.has(t.name.toLowerCase()) && t !== open);
              return (
                <div class="tools-kind" key={kind}>
                  <h4>{label}</h4>
                  <div class="tool-chips">
                    {tools.map((t) => {
                      const key = keyOf(a.agent, t);
                      const state = STATE[t.state] + (t.state === "unknown" ? `: ${unknownWhy(a.agent, t)}` : "");
                      return (
                        <button type="button" key={key} class={`tool-chip is-${t.state}${key === picked ? " is-open" : ""}`}
                          aria-expanded={key === picked} title={[state, whereLabel(t.where), details(t)].join("\n")}
                          onClick={() => setPicked(key === picked ? null : key)}>
                          <span class="tool-dot" aria-label={STATE[t.state]} />
                          {t.name}
                          {t.anvc && <span class="tool-anvc">ANVC</span>}
                        </button>
                      );
                    })}
                  </div>
                  {open && (
                    <div class="tool-picked">
                      <p><b>{open.name}</b> · {STATE[open.state]} · {whereLabel(open.where)}{open.runs ? <> · <code>{open.runs}</code></> : null}</p>
                      <Note key={picked!} tool={open.name} note={noteFor.get(open.name.toLowerCase())} onSave={saveNote} onDone={() => setPicked(null)} />
                    </div>
                  )}
                  {noted.length > 0 && (
                    <ul class="tool-notes">
                      {noted.map((t) => <li key={keyOf(a.agent, t)}><b>{t.name}</b> {noteFor.get(t.name.toLowerCase())!.when}</li>)}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {others.length > 0 && (
          <div class="tools-agent">
            <h3>Other notes</h3>
            <ul class="tool-notes">
              {others.map((n) => <li key={n.id}><b>{n.tool}</b> {n.remote ? <>“{n.when}” <small>from {n.remote}</small></> : n.when}</li>)}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
