/**
 * The first choice a person makes: how much this project keeps.
 *
 * Shown once, right after the tour. Three presets side by side, read at a
 * glance: each lists what is pushed with the code, what stays on this
 * computer and what is not saved, under those words rather than icons alone. People
 * setting up a tool do not read paragraphs, so the explanations live in the
 * settings page, which this points to for anything finer.
 */
import { AssistLevels, loadAssist, saveAssist, type AssistView } from "./assist";
import { useEffect, useState } from "preact/hooks";
import { getJson, Icon, Modal, send } from "./widgets";

type Choice = "off" | "private" | "shared";
interface Preset { label: string; what: string; policy: { fields: Record<string, Choice>; retire: string; tier: string } }

/** The presets offered here, with who each is for. Public repository stays in settings. */
const OFFERED: Array<[string, string, string]> = [
  ["private-repo", "Private", "Only you read it"],
  ["team", "Team", "Others read it"],
  ["minimal", "Minimal", "Keep the least"],
];

/**
 * Things a person recognises, each standing for one or more fields. Grouped so
 * that every row goes to one place under each offered preset.
 */
const ROWS: Array<[string, string[]]> = [
  ["Prompts", ["prompts"]],
  ["Commands", ["commands", "output", "delegations"]],
  ["Files read and edited", ["paths"]],
  ["Sessions", ["transcripts"]],
  ["Goals and reasons", ["why", "files", "recheck"]],
  ["Errors and notes", ["errors", "evidence", "narrative", "ruled_out", "not_investigated", "maps"]],
  ["Full output", ["detail_output", "steps"]],
];

const RANK: Record<Choice, number> = { off: 0, private: 1, shared: 2 };

/**
 * Where a field really ends up under a preset. A record field set to shared
 * still stays on this computer when the preset keeps new records there.
 */
function effective(p: Preset, field: string): Choice {
  const c = p.policy.fields[field] ?? "off";
  return c === "shared" && p.policy.tier === "private" ? "private" : c;
}

/** The widest a row's fields go, so the picker never understates what leaves. */
const rowChoice = (p: Preset, fields: string[]): Choice =>
  fields.map((f) => effective(p, f)).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "off" as Choice);

const PLACES: Array<[Choice, string, string]> = [
  ["shared", "git-commit-horizontal", "Pushed"],
  ["private", "hard-drive", "This computer"],
  ["off", "minus", "Not saved"],
];

export function Choose({ open, onClose, onCustomise }: { open: boolean; onClose: () => void; onCustomise: () => void }) {
  const [presets, setPresets] = useState<Record<string, Preset> | null>(null);
  const [current, setCurrent] = useState("team");
  const [error, setError] = useState("");
  // Asked first, once for every project: how much ANVC tells the agent on its
  // own changes what the agent does more than anything else set here.
  const [assist, setAssist] = useState<AssistView | null>(null);
  const [step, setStep] = useState<"assist" | "share">("share");
  const [chosen, setChosen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadAssist().then((v) => { setAssist(v); if (v.everywhere.from === "default") setStep("assist"); }).catch(() => {});
    void getJson("/api/policy").then((d) => {
      setPresets(d.presets);
      setCurrent(d.preset);
      setChosen(Boolean(d.chosen));
    }).catch(() => setError("Couldn't read the settings"));
  }, [open]);

  const use = async (key: string) => {
    const p = presets![key]!;
    const r = await send("/api/policy", { preset: key, ...p.policy }, "PUT");
    if (!r.ok) { setError((await r.json()).error ?? "Couldn't save"); return; }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} class="tour setup" aria-labelledby="choose-title">
      {open && (<>
        <button type="button" class="icon-button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
        {step === "assist" && assist ? (
          <>
            <h2 id="choose-title">How much should ANVC tell your agent?</h2>
            <p class="settings-sub">For every project. Whatever you pick, you can ask your agent to check ANVC yourself.</p>
            <AssistLevels view={assist} current={assist.everywhere.level} onPick={(level) => void saveAssist({ scope: "everywhere", level }).then((v) => {
              if (!v) { setError("Couldn't save"); return; }
              setAssist(v);
              // Already chose who reads what: nothing left to ask.
              if (chosen) onClose(); else setStep("share");
            })} />
          </>
        ) : (<>
        <h2 id="choose-title">Who can read what the agent saves?</h2>
        {!presets ? <p class="settings-sub">{error || "Reading…"}</p> : (
          <div class="setup-cols">
            {OFFERED.map(([key, name, who]) => {
              const p = presets[key]!;
              const all = Object.keys(p.policy.fields);
              const kept = all.filter((f) => effective(p, f) !== "off").length;
              const shared = all.filter((f) => effective(p, f) === "shared").length;
              const pct = (n: number) => Math.round((100 * n) / all.length);
              return (
                <section key={key} class={`setup-col${current === key ? " is-on" : ""}`}>
                  <header>
                    <b>
                      {name}
                      {key === "team" && <span class="setup-tag">Recommended</span>}
                      {current === key && <span class="setup-tag is-current">Current</span>}
                    </b>
                    <span>{who}</span>
                  </header>
                  <div class="setup-bars">
                    <div><span>Saved</span><i style={{ "--w": `${pct(kept)}%` }} /><b>{pct(kept)}%</b></div>
                    <div class="is-shared"><span>Pushed</span><i style={{ "--w": `${pct(shared)}%` }} /><b>{pct(shared)}%</b></div>
                  </div>
                  <div class="setup-places">
                    {PLACES.map(([place, icon, heading]) => {
                      const rows = ROWS.filter(([, fields]) => rowChoice(p, fields) === place);
                      if (!rows.length) return null;
                      return (
                        <div key={place} class={`setup-place is-${place}`}>
                          <h3><Icon name={icon} size={16} />{heading}</h3>
                          <ul>{rows.map(([label]) => <li key={label}>{label}</li>)}</ul>
                        </div>
                      );
                    })}
                  </div>
                  <button type="button" class={key === "team" ? "button primary" : "button"} onClick={() => void use(key)}>
                    Use
                  </button>
                </section>
              );
            })}
          </div>
        )}
        </>)}
        <footer class="setup-foot">
          <button type="button" class="setup-custom" onClick={onCustomise}>
            <Icon name="sliders" size={18} />
            <span>You can change this in <b>Settings</b>.</span>
            <Icon name="arrow-right" size={16} />
          </button>
          {error && presets && <p class="settings-status is-error">{error}</p>}
        </footer>
      </>)}
    </Modal>
  );
}
