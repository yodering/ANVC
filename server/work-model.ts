import type { Turn } from "./api";
import { plural } from "./widgets";
export type { Turn } from "./api";

export interface WorkRepo {
  name?: string;
  forge: string | null;
  turns: Turn[];
  stats: { records: number; abandoned: number; sessions: number };
}
export type Outcome = "all" | "kept" | "abandoned" | "unexplained";

/** Whether a turn belongs under an outcome tab. "unexplained": the agent gave no reason. */
export const inOutcome = (turn: Turn, outcome: Outcome): boolean =>
  outcome === "all" || (outcome === "unexplained" ? !turn.authored : turn.status === outcome);
export interface Session {
  id: string;
  title: string;
  turns: Turn[];
}

/**
 * Two or three words saying *where* the work happened, for scanning.
 *
 * A column of goal lines all starting "Cache the…", "Invalidate the…" reads as
 * a wall; the eye needs an anchor before the sentence. The paths already carry
 * that, so this is derived rather than stored — no model, no extra field, and
 * it cannot go stale relative to the record.
 *
 * Returns null rather than a filler tag: a label that says nothing is worse
 * than no label, because it still costs a glance.
 */
export function turnArea(turn: Turn): string | null {
  const paths = turn.filesWritten;
  if (!paths.length) return null;

  // The top-level directory is the coarsest honest answer, and for a flat
  // repository the file's own stem is better than nothing.
  const areas = new Set(paths.map((path) => {
    const parts = path.split("/").filter(Boolean);
    return parts.length > 1 ? parts[0]! : (parts[0] ?? "").replace(/\.[^.]+$/, "");
  }));
  if (areas.size === 1) return [...areas][0]!.slice(0, 18);

  // Work spanning several areas is itself worth knowing at a glance, but only
  // while it still reads as a tag: two long names joined are longer than the
  // count, so fall back to counting rather than truncating into nonsense.
  const sorted = [...areas].sort();
  if (sorted.length === 2) {
    const both = `${sorted[0]} + ${sorted[1]}`;
    if (both.length <= 22) return both;
  }
  return `${sorted.length} folders`;
}

export function turnTitle(turn: Turn): string {
  if (turn.authored && turn.intent.trim()) return turn.intent;
  const names = turn.filesWritten.map((path) => path.split("/").pop());
  if (names.length === 1) return `Changed ${names[0]}`;
  if (names.length > 1) return `Changed ${names[0]} and ${plural(names.length - 1, "other file")}`;
  if (turn.shells) return `Ran ${plural(turn.shells, "command")}`;
  if (turn.reads) return `Read ${plural(turn.reads, "file")}`;
  return "Untitled attempt";
}

export function filterTurns(
  turns: Turn[],
  query: string,
  outcome: Outcome,
  session: string | null,
): Turn[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return turns.filter((turn) => {
    // A captured instruction is provenance, not a claim made by the agent.
    const text = [
      turnTitle(turn),
      turn.intent,
      turn.why,
      turn.run,
      ...turn.constraints,
      turn.detail?.narrative,
      turn.detail?.output,
      ...(turn.detail?.ruled_out ?? []).flatMap((item) => [item.approach, item.because]),
      ...(turn.detail?.not_investigated ?? []),
      ...turn.filesWritten,
      ...turn.actions.map((action) => action.full),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      inOutcome(turn, outcome) &&
      (session === null || (turn.run || "unknown") === session) &&
      terms.every((term) => text.includes(term))
    );
  });
}

export function groupSessions(turns: Turn[]): Session[] {
  const groups = new Map<string, Turn[]>();
  for (const turn of [...turns].sort((a, b) =>
    b.start.localeCompare(a.start),
  )) {
    const id = turn.run || "unknown";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(turn);
  }
  return [...groups].map(([id, records]) => ({
    id,
    title: turnTitle(records.find((turn) => turn.status === "kept") ?? records[0]!),
    turns: records,
  }));
}

export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600)
    return `${Math.floor(total / 60)}m${total % 60 ? ` ${total % 60}s` : ""}`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/** Encode each segment so # and ? in a file name cannot change the URL. */
export function fileLink(
  forge: string,
  path: string,
  commit: string | null,
): string | null {
  if (path.startsWith("/") || path.split("/").includes("..")) return null;
  return `${forge}/blob/${commit ?? "HEAD"}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
