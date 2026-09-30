/**
 * What this project saves, field by field, and who can read each part.
 *
 * Opened from the sidebar, and from the last step of the tour, since the tour
 * is where a person learns what the choice means. Every change saves at once:
 * a settings page with a Save button is one people leave without pressing it.
 */
import { DataSettings } from "./results";
import { AssistSettings } from "./assist";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Toggle } from "./folders";
import { anvc, useInstall } from "./install";
import { CopyButton, getJson, plural, Segmented, send } from "./widgets";

type Choice = "off" | "private" | "shared";
interface FieldMeta { group: "raw" | "record"; label: string; what: string }
interface PolicyView {
  preset: string;
  chosen: boolean;
  fields: Record<string, Choice>;
  retire: "auto" | "ask" | "off";
  tier: "private" | "shared";
  fields_meta: Record<string, FieldMeta>;
  presets: Record<string, { label: string; what: string; policy: { fields: Record<string, Choice>; retire: string; tier: string } }>;
  line: string;
}

const RETIRE: Array<[PolicyView["retire"], string, string]> = [
  ["auto", "Auto", "The agent can retire a record when ANVC can confirm why, such as its files being gone. Anything else waits for you."],
  ["ask", "Ask", "The agent asks you first."],
  ["off", "Off", "Records are never retired."],
];

interface Retirement { id: string; target: string; targetIntent: string; reason: string; evidence: string; ts: string }

const REASON: Record<string, string> = {
  replaced: "Replaced", "files-gone": "Files gone", "recheck-passes": "Passes now", wrong: "Wrong",
};

/** What the agent asked to retire, and what is retired, each with the person's answer one click away. */
function Retirements() {
  const [data, setData] = useState<{ pending: Retirement[]; retired: Retirement[] } | null>(null);
  const [error, setError] = useState("");
  const load = () => getJson("/api/retirements").then(setData).catch(() => setError("Couldn't load retirements"));
  useEffect(() => { void load(); }, []);

  const answer = async (target: string, decision: "retire" | "decline" | "restore") => {
    const r = await send("/api/retirements", { target, decision });
    const out = await r.json();
    if (!r.ok || out.error) { setError(out.error ?? "Couldn't save"); return; }
    setError("");
    setData(out);
  };

  if (!data || (!data.pending.length && !data.retired.length)) return error ? <p class="settings-status is-error">{error}</p> : null;
  const row = (item: Retirement, actions: Array<[string, "retire" | "decline" | "restore"]>) => (
    <div class="field-row" key={item.id}>
      <div>
        <b>{item.targetIntent || item.target}</b>
        <span>{REASON[item.reason] ?? item.reason}: {item.evidence.replace(/\s+/g, " ").slice(0, 160)}</span>
      </div>
      <div class="retire-actions">
        {actions.map(([label, decision]) => (
          <button key={decision} type="button" class={decision === "retire" ? "button primary" : "button"} onClick={() => void answer(item.target, decision)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <>
      {data.pending.length > 0 && (
        <>
          <h3>Waiting for you</h3>
          <div class="fields">{data.pending.map((p) => row(p, [["Retire", "retire"], ["Keep", "decline"]]))}</div>
        </>
      )}
      {data.retired.length > 0 && (
        <>
          <h3>Retired</h3>
          <div class="fields">{data.retired.map((p) => row(p, [["Restore", "restore"]]))}</div>
        </>
      )}
      {error && <p class="settings-status is-error">{error}</p>}
    </>
  );
}

/**
 * Local only: the one setting that is a promise rather than a preference.
 * Changing it takes two clicks, and the second says what will happen, since
 * the person reading it now may be the one wondering later why nothing
 * reached the remote, or why something did.
 */
function LocalOnly({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <section class={`local-only${on ? " is-on" : ""}`}>
      <div class="local-head">
        <div>
          <h3>Local only</h3>
          <p>
            {on
              ? "Everything ANVC keeps for this repository stays on this computer: git push and git fetch don't carry records, and every record is private."
              : "Turn this on if the repository has no remote, or records should never leave this computer."}
          </p>
        </div>
        {!asking && <button class="button" onClick={() => setAsking(true)}>{on ? "Turn off" : "Turn on"}</button>}
      </div>
      {asking && (
        <div class="local-confirm" role="alert">
          <p>
            {on
              ? "Turn off local only? Nothing is sent now. Records made while it was on stay private. To share new records, turn on git push below."
              : "Turn on local only? ANVC stops pushing and fetching records here and makes every new record private. Records already on a remote stay there."}
          </p>
          <div>
            <button class="button primary" onClick={() => { setAsking(false); onChange(!on); }}>{on ? "Turn off local only" : "Turn on local only"}</button>
            <button class="button" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

interface RemovalPlan { dir: string; here: number; says: string; remotes: Array<{ remote: string; url: string; refs: number | null; says: string }>; setup: string[] }
interface BackupRow { file: string; name: string; created: string; says: string }

/**
 * Remove ANVC, and put it back from a backup. The confirmation lists what
 * will happen, read from the project and each remote when it opens, and
 * deleting on a remote needs the remote's name typed.
 */
function RemoveAnvc() {
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [asking, setAsking] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ file: string; deleted: string[]; removed: string[] } | null>(null);
  const [restored, setRestored] = useState<{ lines: string[]; commands: Array<[string, string]> } | null>(null);
  const [list, setList] = useState<BackupRow[] | null>(null);
  const [error, setError] = useState("");
  const install = useInstall();
  const loadList = () => void getJson<{ backups?: BackupRow[] }>("/api/restore").then((d) => setList(d.backups ?? []));
  useEffect(loadList, []);

  const ask = async () => {
    setAsking(true); setPlan(null); setRemotes([]); setTyped(""); setError(""); setDone(null);
    const p = await getJson("/api/remove");
    if (p.error) setError(p.error); else setPlan(p);
  };
  const names = remotes.join(", ");
  const removeNow = async () => {
    setBusy(true);
    const r = await send("/api/remove", { remotes, confirm: typed.trim() });
    const out = await r.json();
    setBusy(false);
    if (!r.ok || out.error) { setError(out.error ?? "Couldn't remove ANVC"); return; }
    setAsking(false);
    setDone({
      file: out.file,
      deleted: [
        `Deleted ${out.here} in this clone`,
        ...out.remotes.map((x: { remote: string; deleted: string; error?: string }) => x.error ? `Deleted ${x.deleted} on ${x.remote}, then it failed: ${x.error}` : `Deleted ${x.deleted} on ${x.remote}`),
      ],
      removed: out.uninstalled?.removed ?? [],
    });
    loadList();
  };
  const restoreOne = async (file: string) => {
    const r = await send("/api/restore", { file });
    const out = await r.json();
    if (!r.ok || out.error) { setError(out.error ?? "Couldn't restore"); return; }
    const x = out.restored;
    setError("");
    setList(out.backups);
    setRestored({
      lines: [
        `Restored ${x.added}${x.settings.length ? `, with ${plural(x.settings.length, "settings file")}` : ""}`,
        ...(x.kept.length ? [`Kept ${x.kept.length} that changed after the backup as ${x.kept.length === 1 ? "it is" : "they are"} here: ${x.kept.slice(0, 3).join(", ")}${x.kept.length > 3 ? " and more" : ""}`] : []),
      ],
      commands: [
        ...(x.off && install ? [["ANVC is off in this folder. This puts back what setup changed:", anvc(install, `restore "${x.file}" --setup`)] as [string, string]] : []),
        ...x.pushBack.map((c: string) => ["To put the records back on the remote:", c] as [string, string]),
      ],
    });
  };

  return (
    <>
      <section class="local-only remove-anvc">
        <div class="local-head">
          <div>
            <h3>Remove ANVC</h3>
            <p>Backs up this project's records and settings to a file, then deletes them and takes out what setup added.</p>
          </div>
          {!asking && <button class="button" onClick={() => void ask()}>Remove…</button>}
        </div>
        {asking && (
          <div class="local-confirm" role="alert">
            {!plan ? <p>{error || "Checking this project and its remotes…"}</p> : (
              <>
                <ul class="remove-steps">
                  <li>Back up {plan.says}, with this project's settings, to {plan.dir}</li>
                  {plan.here > 0 && <li>Delete {plan.says} in this clone</li>}
                  {plan.setup.map((line) => <li key={line}>{line}</li>)}
                </ul>
                {plan.remotes.map((r) => r.refs === null
                  ? <p key={r.remote} class="remove-note">Couldn't check {r.remote}: {r.says.replace(/^couldn't reach it: /, "")}</p>
                  : (
                    <label key={r.remote} class="remove-remote">
                      <input type="checkbox" checked={remotes.includes(r.remote)}
                        onChange={(e) => setRemotes(e.currentTarget.checked ? [...remotes, r.remote] : remotes.filter((n) => n !== r.remote))} />
                      <span>Also delete {r.says} on {r.remote} <small>{r.url}</small></span>
                    </label>
                  ))}
                {remotes.length > 0 && (
                  <>
                    <p class="remove-note">Anyone who already fetched them keeps their copy.</p>
                    <label class="remove-type">
                      Type {names} to confirm
                      <input type="text" value={typed} autocomplete="off" spellcheck={false} onInput={(e) => setTyped(e.currentTarget.value)} />
                    </label>
                  </>
                )}
                {error && <p class="remove-note is-error">{error}</p>}
                <div>
                  <button class="button primary" disabled={busy || (remotes.length > 0 && typed.trim() !== names)} onClick={() => void removeNow()}>
                    {busy ? "Removing…" : "Back up and remove"}
                  </button>
                  <button class="button" onClick={() => setAsking(false)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
        {done && (
          <div class="local-confirm" role="status">
            <p>Backed up to <code>{done.file}</code></p>
            <ul class="remove-steps">{done.deleted.map((line) => <li key={line}>{line}</li>)}</ul>
            {done.removed.length > 0 && (
              <>
                <p>Removed from this project:</p>
                <ul class="remove-steps">{done.removed.map((line) => <li key={line}>{line}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </section>

      <h3>Restore</h3>
      {list && !list.length && <p class="settings-sub">No backups of this project.</p>}
      {list && list.length > 0 && (
        <div class="fields">
          {list.map((b) => (
            <div class="field-row" key={b.file}>
              <div><b>{new Date(b.created).toLocaleString()}</b><span>{b.says} · {b.name}</span></div>
              <button type="button" class="button" onClick={() => void restoreOne(b.file)}>Restore</button>
            </div>
          ))}
        </div>
      )}
      {!asking && error && <p class="remove-note is-error">{error}</p>}
      {restored && (
        <div class="remove-restored" role="status">
          {restored.lines.map((line) => <p key={line}>{line}</p>)}
          {restored.commands.map(([label, c]) => (
            <Fragment key={c}>
              <p class="remove-note">{label}</p>
              <div class="policy-line"><code>{c}</code><CopyButton text={c} /></div>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/** A setting as `anvc options` lists it. */
interface Listed { key: string; name: string; what: string; here: string | string[] | null; everywhere?: string | string[] | null; choices: Array<{ value: string; label: string; set: string | null }> }

function useOptions(again: unknown) {
  const [list, setList] = useState<Listed[] | null>(null);
  useEffect(() => { void getJson<{ settings?: Listed[] }>("/api/options").then((o) => setList(o.settings ?? null)).catch(() => {}); }, [again]);
  return [list, setList] as const;
}

/**
 * On-or-off settings from `anvc options`, each its own switch. Under Git:
 * git push, the push check and the AGENTS.md lines, each of which reaches
 * past this computer or into a file the project commits. Local only hides
 * git push, so the list is read again when `again` changes.
 */
function Switches({ heading, keys, again }: { heading: string; keys: string[]; again?: unknown }) {
  const [list, setList] = useOptions(again);
  const [error, setError] = useState("");
  const shown = (list ?? []).filter((s) => keys.includes(s.key));
  if (!shown.length) return null;
  const flip = async (key: string, on: boolean) => {
    const r = await send("/api/options", { key, on });
    const out = await r.json();
    if (!r.ok || out.error) { setError(out.error ?? "Couldn't save"); return; }
    setError("");
    setList(out.settings);
  };
  return (
    <section>
      <h3>{heading}</h3>
      <div class="fields">
        {shown.map((s) => (
          <div class="field-row" key={s.key}>
            <div><b>{s.name}</b><span>{s.what}</span></div>
            <Toggle on={s.here === "on"} label={s.name} onChange={(on) => void flip(s.key, on)} />
          </div>
        ))}
      </div>
      {error && <p class="settings-status is-error">{error}</p>}
    </section>
  );
}

/** Which agents ANVC is connected to, and the command that connects another. */
function Agents() {
  const [list] = useOptions(null);
  const agents = list?.find((s) => s.key === "agents");
  if (!agents) return null;
  const has = (v: Listed["everywhere"], a: string) => [v ?? []].flat().includes(a);
  return (
    <section>
      <h3>Agents</h3>
      <div class="fields">
        {agents.choices.map((c) => (
          <div class="field-row" key={c.value}>
            {has(agents.everywhere, c.value) || has(agents.here, c.value)
              ? <div><b>{c.label}</b><span>{has(agents.everywhere, c.value) ? "Connected in every project" : "Connected in this project"}</span></div>
              : <><div><b>{c.label}</b><span>Not connected</span><code>{c.set}</code></div><CopyButton text={c.set ?? ""} /></>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function Settings() {
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => { void getJson<{ on?: boolean }>("/api/local").then((d) => setLocal(Boolean(d.on))); }, []);
  const changeLocal = async (on: boolean) => {
    if ((await send("/api/local", { on })).ok) setLocal(on);
  };
  const [data, setData] = useState<PolicyView | null>(null);
  const [status, setStatus] = useState<string>("");
  const [line, setLine] = useState("");
  const install = useInstall();

  const load = () => getJson<PolicyView>("/api/policy").then(setData);
  useEffect(() => { void load(); }, []);

  const save = async (next: Partial<PolicyView>) => {
    if (!data) return;
    const body = { preset: next.preset ?? data.preset, fields: next.fields ?? data.fields, retire: next.retire ?? data.retire, tier: next.tier ?? data.tier };
    setData({ ...data, ...body, chosen: true });
    const r = await send("/api/policy", body, "PUT");
    const out = await r.json();
    if (!r.ok || out.error) { setStatus(out.error ?? "Couldn't save"); void load(); return; }
    setData(out as PolicyView);
    setStatus("Saved");
    setTimeout(() => setStatus(""), 1500);
  };

  if (!data) return <p class="map-empty">Loading settings…</p>;
  const base = data.presets[data.preset]?.policy;
  const customised = base && Object.entries(data.fields).some(([k, v]) => base.fields[k] !== v);

  return (
    <div class="settings">
      <AssistSettings />
      <DataSettings />
      {local !== null && <LocalOnly on={local} onChange={(on) => void changeLocal(on)} />}
      {local !== null && <Switches heading="Git" keys={["push", "prepush", "instructions"]} again={local} />}
      <Switches heading="Goals" keys={["approvegoals"]} />
      <h3>Presets</h3>
      <div class="presets">
        {Object.entries(data.presets).map(([key, p]) => (
          <button key={key} type="button" class={`preset${data.preset === key ? " is-on" : ""}`}
            onClick={() => void save({ preset: key, fields: { ...p.policy.fields }, retire: p.policy.retire as PolicyView["retire"], tier: p.policy.tier as PolicyView["tier"] })}>
            <b>{p.label}{data.preset === key && customised && <span>edited</span>}</b>
            <span>{p.what}</span>
          </button>
        ))}
      </div>

      {(["raw", "record"] as const).map((group) => (
        <section key={group}>
          <h3>{group === "raw" ? "Raw log" : "Records"}</h3>
          <p class="settings-sub">
            {group === "raw"
              ? "Never pushed."
              : local ? "Local only is on, so nothing here is pushed." : "Shared fields are pushed with your code."}
          </p>
          <div class="fields">
            {Object.entries(data.fields_meta).filter(([, m]) => m.group === group).map(([key, m]) => (
              <div class="field-row" key={key}>
                <div><b>{m.label}</b><span>{m.what}</span></div>
                <Segmented
                  label={m.label}
                  value={data.fields[key]!}
                  options={group === "raw"
                    ? [["off", "Off"], ["private", "Private"]]
                    : [["off", "Off"], ["private", "Private"], ["shared", "Shared"]]}
                  onChange={(v) => void save({ fields: { ...data.fields, [key]: v } })}
                />
              </div>
            ))}
          </div>
        </section>
      ))}

      <h3>New records</h3>
      <div class="field-row">
        <div><b>Default</b><span>Used when the agent doesn't say.</span></div>
        <Segmented label="New records" value={data.tier}
          options={[["private", "Private"], ["shared", "Shared"]]} onChange={(v) => void save({ tier: v })} />
      </div>

      <h3>Retiring records</h3>
      <p class="settings-sub">Retired records stop being shown to agents. They stay in the work log and can be restored.</p>
      <div class="retire">
        {RETIRE.map(([v, label, what]) => (
          <button key={v} type="button" class={`preset${data.retire === v ? " is-on" : ""}`} onClick={() => void save({ retire: v })}>
            <b>{label}</b>
            <span>{what}</span>
          </button>
        ))}
      </div>
      <Retirements />
      <Agents />

      <h3>Copy settings</h3>
      <p class="settings-sub">Use these settings in another project, or paste someone else's.</p>
      <div class="policy-line">
        <code>{data.line}</code>
        {install && <CopyButton text={anvc(install, `policy import "${data.line}"`)} />}
      </div>
      <form class="policy-import" onSubmit={(e) => {
        e.preventDefault();
        void getJson(`/api/policy/parse?line=${encodeURIComponent(line)}`).then((p) => {
          if (p.error) setStatus(p.error); else { void save(p); setLine(""); }
        });
      }}>
        <input id="policy-line-input" value={line} placeholder="team+steps=shared;retire=auto"
          onInput={(e) => setLine(e.currentTarget.value)} aria-label="Paste a policy line" />
        <button type="submit" disabled={!line.trim()}>Use</button>
      </form>
      <RemoveAnvc />

      {status && <p class={`settings-status${status === "Saved" ? "" : " is-error"}`} role="status">{status}</p>}
    </div>
  );
}
