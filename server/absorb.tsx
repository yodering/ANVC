/**
 * Goals and writing rules from the sessions (protocol/absorb.ts): the choice
 * in Settings, and what the Goals and Writing rules tabs say about it.
 *
 * It spends tokens on the person's plan, so the tabs say plainly whether it's
 * on, what it costs, and how to change it.
 */
import { useEffect, useState } from "preact/hooks";
import { getJson, Hint, Scope, send, when } from "./widgets";

interface View {
  setting: { mode: string; from: "project" | "everywhere" | "default" };
  everywhere: string;
  modes: Record<string, { label: string; what: string; tokens: string }>;
  available: Record<string, boolean>;
  last: { ran: string; runs: number; tokens: number } | null;
}

async function decide(body: object): Promise<View | null> {
  const r = await send("/api/absorb", body);
  return r.ok ? ((await r.json()) as View) : null;
}

function useView() {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => { void getJson<View>("/api/absorb").then(setView).catch(() => {}); }, []);
  return [view, setView] as const;
}

const tokens = (n: number) => n.toLocaleString("en");

/** At the top of the Goals and Writing rules tabs. */
const TITLE = {
  goals: "Goals aren't updated from your sessions",
  rules: "Writing rules aren't updated from your sessions",
  map: "The map isn't updated from your sessions",
} as const;

export function AbsorbNote({ what }: { what: keyof typeof TITLE }) {
  const [view, setView] = useView();
  if (!view) return null;
  const { mode, from } = view.setting;
  const choose = (next: string) => void decide({ mode: next }).then((v) => v && setView(v));
  if (mode === "off") {
    const runners = Object.entries(view.modes).filter(([key]) => key !== "off" && view.available[key]);
    return (
      <div class="absorb-off">
        <div class="absorb-text">
          <p class="absorb-title">
            <Hint id="absorb">{TITLE[what]}</Hint>
          </p>
          <p>
            {from === "project" ? "It's off for this project. " : from === "everywhere" ? "It's off for every project. " : "It's off. "}
            When it's on, a small model updates them after your agent's turns. It doesn't use your agent's context.
          </p>
        </div>
        {runners.length
          ? (
            <div class="presets absorb-choices">
              {runners.map(([key, m]) => (
                <button key={key} type="button" class="preset" onClick={() => choose(key)}>
                  <b>Use {m.label}</b>
                  <span class="preset-cost">{m.tokens}</span>
                </button>
              ))}
            </div>
          )
          : <p class="absorb-missing">It needs the claude or codex command, and neither is installed here.</p>}
      </div>
    );
  }
  return (
    <p class="absorb-on">
      Kept up to date from your sessions by {view.modes[mode]?.label ?? mode}
      {view.last ? ` · last updated ${when(view.last.ran)} · ${tokens(view.last.tokens)} tokens over ${view.last.runs} update${view.last.runs === 1 ? "" : "s"}` : " · no update yet"}
      <button type="button" class="link-button" onClick={() => choose("off")}>Turn off</button>
    </p>
  );
}

/** The choice in Settings, for this project or for every project. */
export function AbsorbSettings() {
  const [view, setView] = useView();
  const [scope, setScope] = useState<"project" | "everywhere" | null>(null);
  useEffect(() => { if (view && !scope) setScope(view.setting.from === "project" ? "project" : "everywhere"); }, [view]);
  if (!view || !scope) return null;
  const current = scope === "project" ? view.setting.mode : view.everywhere;
  const save = async (mode: string) => { const next = await decide({ mode, scope }); if (next) setView(next); };
  return (
    <section class="assist">
      <h3>Goals, writing rules and map from your sessions</h3>
      <p class="settings-sub"><Hint id="absorb">A small model keeps them up to date for you to see, outside the session.</Hint></p>
      <Scope scope={scope} own={view.setting.from === "project"} onScope={setScope}
        onFollow={() => void decide({ scope: "follow" }).then((v) => { if (v) { setView(v); setScope("everywhere"); } })} />
      <div class="presets">
        {Object.entries(view.modes).map(([key, m]) => {
          const missing = key !== "off" && !view.available[key];
          return (
            <button key={key} type="button" class={`preset${current === key ? " is-on" : ""}`} disabled={missing} onClick={() => void save(key)}>
              <b>{m.label}</b>
              <span>{missing ? `Needs the ${key} command, which isn't installed here.` : m.what}</span>
              {!missing && m.tokens && <span class="preset-cost">{m.tokens}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
