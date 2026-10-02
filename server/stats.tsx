/**
 * What ANVC did in this project, and what it cost (protocol/stats.ts).
 *
 * The question a person opening it has is whether ANVC does anything at
 * all, since what it gives an agent goes where nobody reads. So each count
 * is a large number and a short label, what exactly it counts is one hover
 * away (glossary.ts), and the counts still at zero share one line instead of
 * a tile each.
 */
import { useEffect, useState } from "preact/hooks";
import type { Stats } from "../protocol/stats";
import { getJson, Hint } from "./widgets";

const n = (x: number) => x.toLocaleString("en");

interface Count { value: number; label: string; hint: string; note?: string }

// The info mark stays with the label's last word, so it never wraps onto a line alone.
const lead = (label: string) => label.slice(0, label.lastIndexOf(" ") + 1);
const last = (label: string) => label.slice(label.lastIndexOf(" ") + 1);

function Section({ title, counts }: { title: string; counts: Count[] }) {
  const shown = counts.filter((c) => c.value > 0);
  const zero = counts.filter((c) => c.value === 0);
  return (
    <section>
      <h3>{title}</h3>
      {shown.length > 0 && (
        <div class="stat-list">
          {shown.map((c) => (
            <div class="stat" key={c.hint}>
              <span class="stat-value">{n(c.value)}</span>
              <span class="stat-label">{lead(c.label)}<Hint id={c.hint}>{last(c.label)}</Hint></span>
              {c.note && <span class="stat-note">{c.note}</span>}
            </div>
          ))}
        </div>
      )}
      {zero.length > 0 && <p class="stat-zero">Not yet: {zero.map((c) => c.label.toLowerCase()).join(", ")}.</p>}
    </section>
  );
}

export function StatsPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void getJson<Stats & { error?: string }>("/api/stats", { signal: AbortSignal.timeout(20000) })
      .then((v) => (v.error ? setError(v.error) : setS(v))).catch(() => setError("Couldn't read the logs"));
  }, []);
  if (error) return <p class="settings-status is-error">{error}</p>;
  if (!s) return <p class="map-empty">Counting…</p>;
  if (!s.since) return <p class="goals-empty"><b>Nothing yet.</b> ANVC hasn't done anything in this project so far.</p>;
  return (
    <div class="stats">
      <p class="stats-since">Since {new Date(s.since).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</p>
      <Section title="For your agents" counts={[
        { value: s.shown, label: "Past attempts shown", hint: "stat-shown", note: `In ${n(s.sessions)} session${s.sessions === 1 ? "" : "s"}` },
        { value: s.stopped, label: "Commands stopped", hint: "stat-stopped", note: `${n(s.notRunAgain)} not run again` },
        { value: s.matched, label: "Errors matched to past work", hint: "stat-matched" },
        { value: s.recovered, label: "Restored after compaction", hint: "stat-recovered" },
        { value: s.rules, label: "Writing rules given", hint: "stat-rules" },
        { value: s.asked, label: "Lookups by your agent", hint: "stat-asked" },
        { value: s.avoided, label: "Dead ends avoided", hint: "stat-avoided", note: "Estimate" },
      ]} />
      <Section title="Recorded" counts={[
        { value: s.recorded, label: "Attempts with a reason", hint: "stat-recorded" },
        { value: s.saved, label: "Attempts without a reason", hint: "stat-autosaved" },
        { value: s.absorbed.updates, label: "Goal and rule updates", hint: "stat-absorbed" },
        { value: s.confirmed, label: "Marked helpful", hint: "stat-confirmed" },
      ]} />
      <Section title="Cost" counts={[
        { value: Math.round(s.added / 4), label: "Tokens added to agents' context", hint: "stat-added", note: "Estimate, in total" },
        { value: s.absorbed.tokens, label: "Tokens for goal updates", hint: "stat-absorb-tokens" },
      ]} />
    </div>
  );
}
