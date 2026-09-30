/**
 * What happened here since you last looked.
 *
 * Coming back to a project after weeks, the log and the map are all there and
 * nothing says what changed. The brief does: how many attempts, which dead
 * ends are still open, what was established, and which part descriptions the
 * code has since moved past. The agent gets the short form at session start
 * after a gap of a few days.
 */
import type { Database } from "bun:sqlite";
import { openDeadEnds, partMaps, retirements } from "./query";

export interface Brief {
  since: string;
  attempts: number;
  abandoned: number;
  open: Array<{ id: string; goal: string; why: string }>;
  kept: string[];
  stale: number;
  parts: number;
  waiting: number;
}

export function brief(db: Database, repo: string, since: string): Brief {
  const rows = db.prepare(`SELECT status, intent FROM records WHERE ts >= ? AND retires IS NULL AND result IS NULL ORDER BY ts DESC`)
    .all(since) as Array<{ status: string; intent: string }>;
  const maps = partMaps(db, repo);
  return {
    since,
    attempts: rows.length,
    abandoned: rows.filter((r) => r.status === "abandoned").length,
    open: openDeadEnds(db, 5).map((h) => ({ id: h.id, goal: h.intent, why: h.errors[0] ?? "" })),
    kept: [...new Set(rows.filter((r) => r.status === "kept" && r.intent.trim()).map((r) => r.intent))].slice(0, 5),
    stale: maps.filter((m) => m.stale).length,
    parts: maps.length,
    waiting: retirements(db).pending.length,
  };
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const days = (iso: string) => Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));

/** The brief for a person, in full. */
export function briefText(b: Brief): string {
  const lines = [`Since ${day(b.since)} (${days(b.since)} day${days(b.since) === 1 ? "" : "s"}): ${b.attempts} attempt${b.attempts === 1 ? "" : "s"}, ${b.abandoned} abandoned`];
  for (const o of b.open) lines.push(`  open:   "${o.goal.replace(/\s+/g, " ").slice(0, 80)}"${o.why ? ` — ${o.why.slice(0, 80)}` : ""}`);
  for (const k of b.kept) lines.push(`  new:    ${k.replace(/\s+/g, " ").slice(0, 100)}`);
  if (b.stale) lines.push(`  stale:  ${b.stale} of ${b.parts} part descriptions are older than their code`);
  if (b.waiting) lines.push(`  waiting: ${b.waiting} proposed retirement${b.waiting === 1 ? "" : "s"}; anvc retire list`);
  return lines.join("\n");
}

/** The short form an agent gets after a gap. */
export function briefForAgent(b: Brief): string | null {
  if (!b.attempts && !b.open.length) return null;
  const lines = [`anvc: since this repository was last worked on, ${days(b.since)} days ago: ${b.attempts} attempt${b.attempts === 1 ? "" : "s"} recorded, ${b.abandoned} abandoned.`];
  if (b.open.length) lines.push(`  Still open: ${b.open.slice(0, 2).map((o) => `"${o.goal.replace(/\s+/g, " ").slice(0, 70)}"`).join(", ")}.`);
  if (b.stale) lines.push(`  ${b.stale} of ${b.parts} part descriptions are older than their code; check before trusting them.`);
  return lines.join("\n");
}
