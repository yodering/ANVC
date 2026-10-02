/**
 * The writing rules agents follow here: each kind of text, what it covers
 * and where its rules are written. Opening one shows the rules as they read
 * now, from the file they live in. A person adds, edits and removes them
 * here or with anvc rule; see protocol/rules.ts.
 */
import { useEffect, useState } from "preact/hooks";
import { markdown } from "./markdown";
import { AbsorbNote } from "./absorb";
import { getJson, Icon, Segmented, send } from "./widgets";

interface RuleSet {
  id: string;
  name: string;
  applies: string[];
  source: { path: string; heading?: string } | null;
  /** The rules as they read now, unless `missing` says why they can't be read. */
  text: string | null;
  missing?: string;
  remote: string | null;
}

interface Draft { name: string; applies: string; kind: "file" | "here"; file: string; heading: string; text: string }

const where = (r: RuleSet) => r.source ? `${r.source.path}${r.source.heading ? ` › ${r.source.heading}` : ""}` : "Kept in ANVC";

const draftOf = (r?: RuleSet): Draft => ({
  name: r?.name ?? "", applies: r?.applies.join(", ") ?? "",
  kind: r && !r.source ? "here" : "file", file: r?.source?.path ?? "AGENTS.md", heading: r?.source?.heading ?? "",
  text: r && !r.source ? r.text ?? "" : "",
});

function RuleForm({ start, onSave, onCancel }: { start?: RuleSet; onSave: (d: Draft) => void; onCancel: () => void }) {
  const [d, setD] = useState(() => draftOf(start));
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const input = (key: "name" | "applies" | "file" | "heading", label: string, placeholder: string) => (
    <label>
      <span>{label}</span>
      <input value={d[key]} placeholder={placeholder} onInput={(e) => set({ [key]: e.currentTarget.value })} />
    </label>
  );
  return (
    <form class="rule-form" onSubmit={(e) => { e.preventDefault(); onSave(d); }}>
      {input("name", "Name", "Commit messages")}
      {input("applies", "Applies to", "README.md, docs/**/*.md, or commit")}
      <div class="rule-form-where">
        <span>Rules are in</span>
        <Segmented label="Rules are in" value={d.kind} onChange={(kind) => set({ kind })}
          options={[["file", "A file"], ["here", "Written here"]]} />
      </div>
      {d.kind === "file"
        ? <div class="rule-form-pair">{input("file", "File", "AGENTS.md")}{input("heading", "Heading", "Commit messages")}</div>
        : (
          <label>
            <span>Rules</span>
            <textarea rows={7} value={d.text} onInput={(e) => set({ text: e.currentTarget.value })} />
          </label>
        )}
      <div class="rule-actions">
        <button type="submit" class="button primary">Save</button>
        <button type="button" class="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function Rules() {
  const [rules, setRules] = useState<RuleSet[] | null>(null);
  const [files, setFiles] = useState<Array<{ path: string; scope: "everywhere" | "project"; text: string }>>([]);
  /** The rule set being edited, "new" for one being added. */
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getJson<{ rules?: RuleSet[]; files?: typeof files; error?: string }>("/api/rules")
      .then((v) => { setFiles(v.files ?? []); v.rules ? setRules(v.rules) : setError(v.error ?? "Couldn't load the writing rules"); })
      .catch(() => setError("Couldn't load the writing rules"));
  }, []);

  const post = async (body: object) => {
    const r = await send("/api/rules", body);
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.error) { setError(out.error ?? "Couldn't save"); return; }
    setError("");
    setRules(out.rules);
    setEditing(null);
  };
  const save = (id: string | null) => (d: Draft) => void post({
    action: id ? "change" : "add", id, name: d.name, applies: d.applies,
    ...(d.kind === "here" ? { text: d.text } : { from: `${d.file}${d.heading.trim() ? `#${d.heading}` : ""}` }),
  });
  const remove = (r: RuleSet) => {
    if (confirm(`Remove "${r.name}"? Agents stop getting these rules.`)) void post({ action: "remove", id: r.id });
  };

  return (
    <section class="rules" aria-labelledby="rules-heading">
      <div class="rules-head">
        <h2 id="rules-heading">Writing rules</h2>
        {rules && editing !== "new" && <button type="button" class="button" onClick={() => setEditing("new")}><Icon name="plus" size={14} />Add rule set</button>}
      </div>
      <AbsorbNote what="rules" />
      {rules?.length === 0 && editing !== "new" && (
        <p class="rules-empty">
          No rule sets in ANVC yet. A rule set points at rules you already wrote, such as a heading in AGENTS.md. Your agent then gets them just before it writes what they cover, such as a commit message.
        </p>
      )}
      {editing === "new" && <RuleForm onSave={save(null)} onCancel={() => setEditing(null)} />}
      {rules && rules.length > 0 && (
        <div class="rule-list">
          {rules.map((r) => editing === r.id
            ? <RuleForm key={r.id} start={r} onSave={save(r.id)} onCancel={() => setEditing(null)} />
            : (
              <details class="rule" key={r.id}>
                <summary>
                  <b>{r.name}</b>
                  <span class="rule-applies">{r.applies.map((a) => <code key={a}>{a}</code>)}</span>
                  <span class={`rule-where${r.missing ? " is-missing" : ""}`}>
                    {where(r)}{r.missing && " · not found"}
                  </span>
                  {r.remote && <span class="rule-from">From {r.remote}</span>}
                </summary>
                {r.missing
                  ? <p class="rule-missing">{r.missing}</p>
                  : <div class="rule-text md">{markdown(r.text ?? "")}</div>}
                <div class="rule-actions">
                  <button type="button" class="button" onClick={() => setEditing(r.id)}>Edit</button>
                  <button type="button" class="button" onClick={() => remove(r)}>Remove</button>
                </div>
              </details>
            ))}
        </div>
      )}
      {files.length > 0 && (
        <>
          <h3 class="rules-files-head">Your own rule files</h3>
          <p class="rules-files-sub">Your agent already reads these. ANVC shows them here as they are.</p>
          <div class="rule-list">
            {files.map((f) => (
              <details class="rule" key={f.path}>
                <summary>
                  <b><code>{f.path}</code></b>
                  <span class="rule-where">{f.scope === "everywhere" ? "Your global file" : "This repository's"}</span>
                </summary>
                <div class="rule-text md">{markdown(f.text)}</div>
              </details>
            ))}
          </div>
        </>
      )}
      {error && <p class="settings-status is-error" role="alert">{error}</p>}
    </section>
  );
}
