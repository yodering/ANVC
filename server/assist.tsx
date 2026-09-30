/**
 * How much ANVC tells the agent on its own: three choices, and a switch for
 * each moment. Shown once when setting up (choose.tsx) and at the top of
 * Settings, since it changes what the agent does more than anything else here.
 */
import { useEffect, useState } from "preact/hooks";
import { Toggle } from "./folders";
import { getJson, Scope, send } from "./widgets";

type Level = "auto" | "start" | "ask";
interface Assist { level: Level; moments: Record<string, boolean>; from: "project" | "everywhere" | "default" }
export interface AssistView {
  project: Assist;
  everywhere: Assist;
  levels: Record<Level, { label: string; what: string; moments: Record<string, boolean> }>;
  moments: Record<string, { label: string; what: string }>;
}

export async function saveAssist(body: object): Promise<AssistView | null> {
  const r = await send("/api/assist", body);
  return r.ok ? ((await r.json()) as AssistView) : null;
}

export const loadAssist = () => getJson<AssistView>("/api/assist");

/** The three choices, as cards. */
export function AssistLevels({ view, current, edited, onPick }: {
  view: AssistView; current: Level; edited?: boolean; onPick: (level: Level) => void;
}) {
  return (
    <div class="presets">
      {(Object.keys(view.levels) as Level[]).map((key) => (
        <button key={key} type="button" class={`preset${current === key ? " is-on" : ""}`} onClick={() => onPick(key)}>
          <b>
            {view.levels[key].label}
            {key === "auto" && <span>Recommended</span>}
            {current === key && edited && <span>edited</span>}
          </b>
          <span>{view.levels[key].what}</span>
        </button>
      ))}
    </div>
  );
}

/** The Settings section: which projects it applies to, the level, and each moment. */
export function AssistSettings() {
  const [view, setView] = useState<AssistView | null>(null);
  const [scope, setScope] = useState<"project" | "everywhere" | null>(null);
  useEffect(() => { void loadAssist().then((v) => { setView(v); setScope(v.project.from === "project" ? "project" : "everywhere"); }); }, []);
  if (!view || !scope) return null;

  const shown = scope === "project" ? view.project : view.everywhere;
  const edited = Object.entries(shown.moments).some(([k, v]) => view.levels[shown.level].moments[k] !== v);
  const save = async (change: object) => {
    const next = await saveAssist({ scope, ...change });
    if (next) setView(next);
  };

  return (
    <section class="assist">
      <h3>Your agent</h3>
      <p class="settings-sub">What ANVC tells your agent without being asked. You can always ask it to check ANVC yourself.</p>
      <Scope scope={scope} own={view.project.from === "project"} onScope={setScope}
        onFollow={() => void saveAssist({ clear: true }).then((v) => { if (v) { setView(v); setScope("everywhere"); } })} />
      <AssistLevels view={view} current={shown.level} edited={edited} onPick={(level) => void save({ level })} />
      <div class="fields">
        {Object.entries(view.moments).map(([key, meta]) => (
          <div class="field-row" key={key}>
            <div><b>{meta.label}</b><span>{meta.what}</span></div>
            <Toggle on={shown.moments[key]!} label={meta.label} onChange={(on) => void save({ moment: key, on })} />
          </div>
        ))}
      </div>
    </section>
  );
}
