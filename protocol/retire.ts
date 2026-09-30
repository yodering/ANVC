/**
 * Taking a record out of what agents are shown, with the person in charge.
 *
 * An append-only log never forgets, which is the point, and also the risk: a
 * dead end that someone since got past keeps being injected as a warning, and
 * the agent obeys it. Search ranks by words, not by truth, so ranking alone
 * propagates whatever was written first.
 *
 * Retiring fixes that without deleting anything. The retired record stays in
 * git and in search, labelled; it stops being injected. Every step is itself
 * a record, so the whole exchange — who proposed it, on what evidence, who
 * decided — can be read back later, and undone.
 *
 * How much the agent may do alone is the person's choice, per project, in the
 * policy: `auto`, `ask` or `off`. Even under `auto`, only a reason anvc can
 * check itself is acted on at once. A reason that rests on the agent's word
 * becomes a proposal, because an agent confidently retiring a true warning is
 * the most expensive mistake this can make.
 */
import type { Database } from "bun:sqlite";
import { gitOrNull, OID } from "./git";
import { readPolicy } from "./policy";
import { retirements, type Retirement } from "./query";
import {
  appendRecord, RETIRE_REASONS, ulid,
  type CheckpointRecord, type RetireReason, type RetireState, type Tier,
} from "./record";

export type Actor = { kind: "agent"; session: string; agent: string } | { kind: "person" };

export interface RetireResult {
  state: RetireState;
  id: string;
  ref: string;
  tier: Tier;
  /** What anvc checked, in a sentence, or why it could not. */
  checked: string;
}

/** The commit a decision was made at; a blob of zeros outside any history. */
export function headAnchor(repo: string): CheckpointRecord["anchor"] {
  const head = gitOrNull(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]) ?? "";
  return OID.test(head) ? { kind: "commit", oid: head } : { kind: "blob", oid: "0".repeat(40) };
}

type Row = { id: string; ts: string; status: string; tier: string; intent: string; retired: string | null; retires: string | null };

/**
 * Whether anvc itself can confirm the reason. Two reasons can be checked from
 * the repository alone; the other two rest on what the retirer saw.
 */
export function verify(db: Database, repo: string, target: Row, reason: RetireReason, by?: string): { ok: boolean; checked: string } {
  if (reason === "replaced") {
    if (!by) return { ok: false, checked: "No newer record was named. Pass `by` with its id." };
    const newer = db.prepare(`SELECT id, ts, retired, retires FROM records WHERE id = ?`).get(by) as Row | null;
    if (!newer) return { ok: false, checked: `No record ${by} in this repository.` };
    if (newer.retires) return { ok: false, checked: `${by} is a retirement decision, not a record that could replace this one.` };
    if (newer.retired) return { ok: false, checked: `${by} is itself retired.` };
    if (newer.ts <= target.ts) return { ok: false, checked: `${by} is older than the record it would replace.` };
    return { ok: true, checked: `Checked: ${by} exists, is newer, and is not retired.` };
  }
  if (reason === "files-gone") {
    const files = (db.prepare(`SELECT DISTINCT path FROM files WHERE id = ?`).all(target.id) as Array<{ path: string }>).map((f) => f.path);
    if (!files.length) return { ok: false, checked: "The record names no files, so there is nothing to check." };
    const still = files.filter((f) => gitOrNull(repo, ["cat-file", "-e", `HEAD:${f}`]) !== null);
    if (still.length) return { ok: false, checked: `Still at HEAD: ${still.slice(0, 3).join(", ")}${still.length > 3 ? ` and ${still.length - 3} more` : ""}.` };
    return { ok: true, checked: `Checked: none of its ${files.length} file${files.length === 1 ? "" : "s"} exist at HEAD.` };
  }
  // A recheck is a shell command from a record, and records arrive from
  // teammates with `git fetch`. anvc does not run them; the agent can, under
  // its own permission prompts, and quote the result as evidence.
  if (reason === "recheck-passes") return { ok: false, checked: "anvc does not run recheck commands itself, so this rests on the evidence given." };
  return { ok: false, checked: "This rests on the evidence given." };
}

function targetRow(db: Database, id: string): Row {
  const row = db.prepare(`SELECT id, ts, status, tier, intent, retired, retires FROM records WHERE id = ?`).get(id) as Row | null;
  if (!row) throw new Error(`No record ${id}. Ids come from a summary line, anvc_tried or anvc_dead_ends.`);
  if (row.retires) throw new Error(`${id} is a retirement decision. To undo a retirement, restore the record it retired.`);
  return row;
}

function write(repo: string, target: Row, state: RetireState, reason: RetireReason, evidence: string, actor: Actor, by?: string): { id: string; ref: string; tier: Tier } {
  // A proposal or a decline is a question between this agent and this person,
  // so it stays here. A retirement or a restore changes what everyone who has
  // the record is shown, so it goes where the record went.
  const tier: Tier = state === "proposed" || state === "declined" ? "private" : target.tier === "private" ? "private" : "shared";
  const verb = { proposed: "Propose retiring", retired: "Retire", declined: "Keep", restored: "Restore" }[state];
  const record: CheckpointRecord = {
    anvc: 0,
    id: ulid(),
    anchor: headAnchor(repo),
    retires: { id: target.id, state, reason, evidence: evidence.trim().slice(0, 2000), ...(by ? { by } : {}) },
    session: actor.kind === "agent"
      ? { agent: actor.agent, run_id: actor.session }
      : { agent: "person", run_id: "anvc-person" },
    intent: { goal: `${verb}: ${target.intent || target.id}`.slice(0, 200) },
    outcome: { status: "kept" },
    ts: new Date().toISOString(),
  };
  const { ref } = appendRecord(repo, record, { tier });
  return { id: record.id, ref, tier };
}

/**
 * An agent asks to retire a record. What happens depends on the policy:
 * `off` refuses, `ask` proposes, `auto` retires when anvc can check the reason
 * and proposes when it cannot.
 */
export function agentRetire(db: Database, repo: string, args: {
  target: string; reason: string; evidence: string; by?: string; session: string; agent: string;
}): RetireResult {
  const mode = readPolicy(repo).retire;
  if (mode === "off") {
    throw new Error("Retirement is off in this project; the person chose that. If this record is wrong, tell them and say why, or call anvc_feedback.");
  }
  if (!Object.hasOwn(RETIRE_REASONS, args.reason)) throw new Error(`reason must be one of ${Object.keys(RETIRE_REASONS).join(", ")}`);
  if (!args.evidence?.trim()) throw new Error("evidence is required: say what you saw that the record did not predict");
  const reason = args.reason as RetireReason;
  const target = targetRow(db, args.target);
  if (target.retired) throw new Error(`${args.target} is already retired.`);
  const waiting = retirements(db).pending.find((p) => p.target === target.id);
  if (waiting) throw new Error(`A retirement of ${args.target} is already waiting for the person (proposal ${waiting.id}).`);

  const { ok, checked } = verify(db, repo, target, reason, args.by);
  const state: RetireState = mode === "auto" && ok ? "retired" : "proposed";
  const written = write(repo, target, state, reason, args.evidence, { kind: "agent", session: args.session, agent: args.agent }, args.by);
  return { state, checked, ...written };
}

/** A person's decision. The person is the authority, so the mode does not apply. */
export function personDecide(db: Database, repo: string, target: string, decision: "retire" | "decline" | "restore", note?: string, reason?: string): RetireResult {
  const row = targetRow(db, target);
  const pending = retirements(db).pending.find((p) => p.target === target);
  if (decision === "decline" && !pending) throw new Error(`Nothing is waiting to retire ${target}.`);
  if (decision === "restore" && !row.retired) throw new Error(`${target} is not retired.`);
  if (decision === "retire" && row.retired) throw new Error(`${target} is already retired.`);
  const base: Retirement | undefined = pending
    ?? retirements(db).all.find((r) => r.target === target && r.state === "retired");
  const chosen = (reason ?? base?.reason ?? "wrong") as RetireReason;
  if (!Object.hasOwn(RETIRE_REASONS, chosen)) throw new Error(`reason must be one of ${Object.keys(RETIRE_REASONS).join(", ")}`);
  const state: RetireState = decision === "retire" ? "retired" : decision === "decline" ? "declined" : "restored";
  const evidence = note?.trim()
    || (decision === "retire" && pending ? `Approved: ${pending.evidence}` : `${state[0]!.toUpperCase()}${state.slice(1)} by the person.`);
  const written = write(repo, row, state, chosen, evidence, { kind: "person" }, base?.by ?? undefined);
  return { state, checked: "Decided by the person.", ...written };
}
