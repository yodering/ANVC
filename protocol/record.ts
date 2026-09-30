/**
 * ANVC checkpoint records: envelope v0, validation, and Git storage.
 *
 * See spec/anvc-checkpoint-v0.md. Records are immutable blobs addressed by a
 * ref, in one of two tiers:
 *
 *   refs/anvc/<session>/<seq>          shared — travels with `git push`
 *   refs/anvc-private/<session>/<seq>  private — never leaves this machine
 *
 * The private tier is enforced by git rather than by this code: setup's push
 * refspec is `refs/anvc/*`, which does not match `refs/anvc-private/`, so there
 * is no path by which a forgotten flag publishes a private record.
 */
import { isLocalOnly, LOCAL_ONLY_REFUSAL } from "./localonly";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { git, gitOrNull, OID, readRefs } from "./git";
import { readPolicy, type Field } from "./policy";
import { redactSecrets } from "./scrub";

export const ENVELOPE_VERSION = 0 as const;
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_PROMPT_BYTES = 8 * 1024;
export const MAX_ACTIONS = 1000;
/**
 * Bounds on `outcome.errors`, so it cannot push a record past the 64 KiB cap.
 *
 * Without these the field was unbounded while everything around it was
 * bounded, and a long turn full of failing commands became a record that
 * `validateRecord` rejected — silently, because the ingest loop counts a
 * rejected record as "skipped". The turns lost that way are the ones most
 * worth keeping.
 */
export const MAX_ERRORS = 20;
export const MAX_ERROR_BYTES = 512;
/** Evidence pointers per record. Enough to address a failure, not a transcript. */
export const MAX_EVIDENCE = 50;
/**
 * Room for the dense half of a record.
 *
 * Deliberately large. A record is capped at 64 KiB and this repository's
 * records were using 4.5% of that, because the size of what we stored was
 * being decided by the size of what we were willing to inject. Those are
 * different budgets: context is scarce, a git blob is not.
 */
export const MAX_DETAIL_BYTES = 24 * 1024;
export const MAX_DETAIL_ITEMS = 40;
/** A tool note's tool name and its text, in characters. */
export const MAX_TOOL_NAME = 120;
export const MAX_NOTE = 300;

export type AnchorKind = "commit" | "blob" | "tree";
export type OutcomeStatus = "kept" | "abandoned";
/** How far an abandoned attempt's failure reaches. See `outcome.scope`. */
export type FailureScope = "local" | "general";
export type RetireState = "proposed" | "retired" | "declined" | "restored";
/**
 * Why a record should stop being shown. Four, because each needs different
 * proof: two can be checked by anvc itself, two rest on what the retirer saw.
 */
export const RETIRE_REASONS = {
  replaced: "A newer record says the same thing better, or says the opposite and is right.",
  "files-gone": "Every file the record is about has been deleted or moved.",
  "recheck-passes": "Its recheck command now passes, so this no longer fails.",
  wrong: "It was never true, or the code changed and it stopped being true.",
} as const;
export type RetireReason = keyof typeof RETIRE_REASONS;

export interface Action {
  kind: "read" | "write" | "shell";
  path?: string;
  command?: string;
  bytes?: number;
  ts: string;
}

export interface CheckpointRecord {
  anvc: typeof ENVELOPE_VERSION;
  id: string;
  anchor: { kind: AnchorKind; oid: string };
  /**
   * The attempt this one continues from: same problem, next try.
   *
   * Narrower than it used to be. This edge was carrying two different
   * relations — "I tried again after that failed" and "this work happened
   * after that work" — and measured on this repository one of the two links
   * we had was the second kind, pointing at unrelated work. An edge that means
   * two things cannot be queried for either. `serves` now carries the other
   * relation.
   */
  parent?: string;
  /**
   * The goal this attempt is in service of.
   *
   * `parent` answers "what did I try before this"; nothing answered "what is
   * all of this for". Measured on this repository: six of nine agent-authored
   * records are roots, and three of those six were one piece of work serving
   * one objective that is recorded nowhere — it lived in the session context
   * and died with it. The log kept every what and lost every why.
   *
   * Single parent, deliberately. Jira collapsed Epic Link and Parent Link into
   * one `parent` field after carrying both; GitHub ships one
   * `parent_issue_url`. A DAG here would be a project-management system, and
   * those are the fields nobody fills in.
   */
  serves?: string;
  /**
   * A record this one replaces, when the goal itself changed.
   *
   * Written by the newer record pointing backwards, never by annotating the
   * old one, because records are immutable — the same constraint that makes an
   * RFC carry `Obsoletes:` rather than the obsoleted RFC naming its successor.
   *
   * This repository already does exactly this in prose: `docs/thesis.md`,
   * `docs/plan-v1.1.md` and `docs/status.md` all carry supersede headers. The
   * field lifts a convention we had already invented into something queryable.
   */
  supersedes?: string;
  /**
   * The agent's own account of how a part of the system fits together.
   *
   * Everything else in this file records an *event* — one attempt, kept or
   * abandoned. This records *understanding*, and it exists because the derived
   * graph cannot produce it. We can compute which files were touched together
   * and draw that; what we cannot compute is what a part is for, what feeds
   * it, or why it is shaped the way it is. That meaning is exactly what a
   * reader needs after three months and four compactions, and exactly what an
   * import-graph or an AST view leaves out.
   *
   * It is a normal record, so it inherits the two properties that matter:
   * `supersedes` makes the newest map for a part the current one while every
   * earlier map stays readable as history, and being a git ref means the
   * understanding travels with the repository instead of dying in a session.
   *
   * `part` is the thing being described — a directory, a file, or a name for a
   * subsystem that spans several. One map per part, superseded as it changes.
   */
  map?: {
    part: string;
    /** What this part is for, in the agent's own words. One or two sentences. */
    does: string;
    /**
     * Where this sits in the system, so a diagram can rank it.
     *
     * Without this every part is a peer and a layered layout has nothing to
     * order by, which is how an architecture diagram degenerates into a
     * cloud of boxes. The values are deliberately few and concrete: an agent
     * choosing between five named positions is reliable, one inventing its
     * own taxonomy is not.
     */
    layer?: "edge" | "core" | "store" | "tool" | "surface";
    /**
     * The files and directories this part owns.
     *
     * The join between the authored map and the recorded evidence. Attempts
     * name files; maps name parts; this is what lets "what has been tried in
     * the indexing layer" be answerable at all. Prefixes are allowed, so
     * `protocol/` claims everything beneath it.
     */
    owns?: string[];
    /** Parts it depends on, and what it takes from each. */
    reads?: Array<{ part: string; what: string }>;
    /** Parts that depend on it, and what they take. */
    feeds?: Array<{ part: string; what: string }>;
    /**
     * Design decisions that hold for this part, and why.
     *
     * The field a flowchart never has and the one that answers "why is it like
     * this" — the question that actually costs time when returning to a
     * project.
     */
    decisions?: Array<{ what: string; because: string }>;
  };
  /**
   * A decision about another record: take it out of what agents are shown.
   *
   * A record that was true once and is not now keeps getting injected, and an
   * agent acts on it — the top complaint about agent memory. Deleting it would
   * lose the history and let a wrong call destroy the thing it was wrong
   * about, so retirement is a record like any other, pointing at its target.
   * The retired record stays searchable, labelled; it stops being injected.
   *
   * `state` carries the whole exchange in the log: an agent proposes, a person
   * retires or declines, and a person can restore later. The latest decision
   * for a target wins.
   */
  retires?: {
    id: string;
    state: RetireState;
    reason: RetireReason;
    /** What the retirer saw. For `replaced`, the newer record's id is in `by`. */
    evidence: string;
    by?: string;
  };
  /**
   * A value someone will rely on (a number in a paper, a benchmark, a count)
   * and everything needed to trust it later: where it lives, how it was made,
   * what it depends on, why, and whether it is final.
   *
   * A number found months later is useless without its standing. Knowing it
   * came from results/v6.json doesn't say whether v6 was the good run, whether
   * a later change made it stale, or whether it was locked for the paper and
   * should not be re-run. So a result carries a status the person controls,
   * and ANVC checks the files it names against their fingerprints whenever it
   * is shown.
   *
   * A later record with `of` changes a result's status, as a retirement
   * decision does for a record: the history stays, and the latest decision
   * wins, a person's over an agent's. See protocol/results.ts.
   */
  result?: {
    /** What the value is, as someone would say it: "D accuracy", "Table 2 F1". */
    name: string;
    /** As written where it is used: "88.1%", "0.8812", "1.2 s". */
    value?: string;
    /** For a status change: the result record it changes. */
    of?: string;
    status: ResultStatus;
    /** The part of the project it belongs to, so only that part's changes make it stale. */
    part?: string;
    /** The file it was read from, and ANVC's fingerprint of it then. `read` is what ANVC found at `key`. */
    source?: { path: string; key?: string; hash?: string; bytes?: number; read?: string };
    /** The command that produced it. */
    command?: string;
    /** Settings it was produced with: seed, learning rate, dataset split. */
    settings?: Record<string, string>;
    /** Files and folders it was computed from, fingerprinted when it was recorded. */
    depends?: Array<{ path: string; hash?: string; bytes?: number }>;
    /** Results it was computed from: a mean of seeds, a table total. */
    derived_from?: string[];
    /** An earlier result this one replaces: v6 over v4. */
    replaces?: string;
    /** Where it is used: "paper.tex Table 2". */
    used_in?: string[];
    /** Recorded after the run, from files the agent didn't see being made. */
    after_the_fact?: boolean;
  };
  /**
   * A goal or sub-goal of the project, and how far it has got.
   *
   * After each compaction the person had to repeat what the project was for
   * and what was done. A goal is versioned the way a result is: a change is a
   * new record with `of` naming the goal, carrying its title and status as
   * they are after the change, and the latest wins. The reason is the usual
   * `intent.why`. Named `objective` so it can't be mistaken for `intent.goal`,
   * the attempt's own line. See protocol/goals.ts.
   */
  objective?: {
    title: string;
    /** The goal this one is a sub-goal of. Set when it is added, never changed. */
    parent?: string;
    status: GoalStatus;
    /** For a change: the goal it changes. */
    of?: string;
    /**
     * An agent's addition or change that waits for the person, when the
     * project asks for that. It counts once the person accepts it.
     */
    proposed?: true;
  };
  /**
   * A set of writing rules: which kind of text it covers and where its text
   * is written, so the rules keep one home (usually a heading in AGENTS.md)
   * and ANVC only points at it. A later record with `of` changes or removes
   * a rule set; the latest change wins. See protocol/rules.ts.
   */
  rule?: {
    /** What kind of text it covers, as someone would say it: "Commit messages". */
    name: string;
    /** File globs (`README.md`, `docs/**\/*.md`), or the word `commit` for commit messages. */
    applies?: string[];
    /** A file in the repository and, optionally, the heading its section starts at. */
    source?: { path: string; heading?: string };
    /** The rules themselves, when they aren't written in a file. */
    text?: string;
    /** For a change or a removal: the rule set it changes. */
    of?: string;
    removed?: boolean;
  };
  /**
   * When to use a tool, such as "ponytail-audit" for "cleanup audits", kept
   * with the project so every agent is told at session start. A replacement
   * points at the first note with `of`, and the latest wins, as for results.
   * See protocol/tools.ts.
   */
  tool_note?: { tool: string; when: string; of?: string };
  /**
   * Something the person asked for, on the Status list: up next, in
   * progress, done or dropped. A change points at the first version with
   * `of` and carries the item as it is after the change; the latest wins, as
   * for goals. `rank` orders Up next, lowest first. See protocol/status.ts.
   */
  status_item?: { title: string; state: ItemState; goal?: string; rank?: number; of?: string };
  session: { agent: string; model?: string; run_id: string };
  /**
   * What the work was for, written by the agent that did it.
   *
   * `goal` is the field of record: one line, the agent's own statement of what
   * it set out to do. The agent read the files and ran the commands, so it is
   * the only party with that context — a second model summarising the
   * transcript afterwards has strictly less information, and a raw prompt is
   * input rather than an artifact. `prompt` stays available for provenance and
   * for agents that cannot yet emit, but `goal` is what a reader sees.
   */
  intent: { goal?: string; prompt?: string; plan?: string[]; constraints?: string[]; why?: string };
  actions?: Action[];
  delta?: { files?: string[]; stats?: { added: number; removed: number } };
  /**
   * What happened, and how far the failure reaches.
   *
   * `scope` exists because an abandoned record currently cannot distinguish
   * "this step failed" from "this whole approach is dead", and those are
   * opposite instructions to a later reader. The precedent is the CDCL nogood,
   * where a smaller recorded conflict set is a more general one and sets how
   * far the search may jump back.
   *
   * The asymmetry matters more than the field. A solver *derives* that scope
   * from an implication graph; an agent would be *asserting* it, and a wrongly
   * general record is an unsound nogood — it prunes an approach that still
   * works, permanently, with no way for the next reader to tell. So `local` is
   * the default and the safe answer, and `general` has to be earned.
   *
   * `recheck` is the other half. A verdict a later agent can only believe is
   * worth little; a command it can run is worth a lot, and measured elsewhere
   * an agent that must *decide* to go fetch evidence under-fetches by about
   * half. One command is a cheaper action than a judgement call.
   */
  outcome: {
    status: OutcomeStatus;
    tests?: { passed: number; failed: number };
    errors?: string[];
    scope?: FailureScope;
    recheck?: string | null;
  };
  /**
   * Where the claim can be checked, addressed rather than described.
   *
   * Prose is a second lossy compression of what already happened; a path, a
   * line and a commit are things a later agent can open. This is also what
   * makes staleness computable instead of guessable: a record anchored to a
   * commit can be asked "has any of this changed since", and a MEMORY.md
   * cannot.
   */
  evidence?: Array<{ path?: string; line?: number; commit?: string; note?: string }>;
  /**
   * Who is asserting this, so agent output is not weighed as human decision.
   *
   * Defaults to `agent` by omission. A record only becomes `human` when a
   * person confirmed it, and nothing in the write path may set that on its
   * own.
   */
  authority?: "agent" | "human";
  /**
   * The dense half: everything a later reader might need and nobody can
   * reconstruct once it is gone.
   *
   * Nothing here is ever injected. Two budgets were being conflated for
   * months — context is scarce and rationed hard, disk is not — and collapsing
   * them meant storing a single line because a single line was all we were
   * willing to show. Measured on this repository before this field existed:
   * records used **4.5%** of the 64 KiB each one is already allowed.
   *
   * The case for writing more than a verdict is not that it scores better this
   * afternoon. It is that the compressor cannot know what a later question
   * will hinge on, so every byte dropped at write time is a question refused
   * in advance, permanently. A one-line verdict says "X failed because Y" and
   * a reader can only obey it. The full output of the command that failed lets
   * a fresh reader notice that Y was a broken fixture and X works fine — which
   * is the single most valuable thing this system could ever do, and the one
   * thing a paraphrase makes impossible.
   *
   * `narrative` is here because it was measured to win. A prose account of
   * what happened scored at least as well as our structured line at changing
   * what a model does, so keeping only the structure was discarding the part
   * that demonstrably worked. Structure and prose are not competitors; the
   * structure is what queries, and the prose is what a reader understands.
   *
   * `not_investigated` is the rarest and possibly the most useful: the
   * difference between "we ruled this out" and "we never looked". A reader who
   * knows which is which can pick up exactly where the last one stopped
   * thinking, and no other field in any comparable system records it.
   */
  detail?: {
    /** Verbatim output of what failed. Never a summary — the summary is `why`. */
    output?: string;
    /** What was happening around the attempt, in prose, for a human-shaped reader. */
    narrative?: string;
    /** Approaches considered and set aside, with the reason each was set aside. */
    ruled_out?: Array<{ approach: string; because: string }>;
    /** Questions left open. Not the same as ruled out, and that difference is the point. */
    not_investigated?: string[];
    /** The exact commands run, in order, so the attempt can be repeated. */
    commands?: string[];
  };
  ts: string;
  truncated?: boolean;
}

export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION = /^[a-z0-9][a-z0-9-]*$/;

/** A time and sixteen bytes as a ULID, in Crockford base32. */
function encode(now: number, bytes: Uint8Array): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i++) { time = alphabet[remaining % 32]! + time; remaining = Math.floor(remaining / 32); }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += alphabet[bytes[i]! % 32];
  return time + tail;
}

/** Crockford base32 ULID: sortable by creation time, unique without coordination. */
export const ulid = (now = Date.now()): string => encode(now, crypto.getRandomValues(new Uint8Array(16)));

/**
 * A ULID derived from content rather than randomness, so the same input always
 * yields the same id.
 *
 * Re-running `anvc ingest` over an unchanged capture directory used to write
 * every turn again: the records were byte-identical apart from a random ULID,
 * so each got a fresh id, a fresh sequence and a fresh ref, and the
 * "Refusing to overwrite" guard never fired. Three runs produced 93 refs for 57
 * real turns, reported as "(0 already present)".
 *
 * Identity here is the turn, not the moment it was ingested. The parts are
 * joined with NUL so no combination of field values can collide by running
 * together, and the timestamp prefix is kept so ids still sort by time.
 *
 * Content-addressing for this is the approach claude-mem uses
 * (`computeObservationContentHash`, Apache-2.0); see
 * docs/decisions/2026-09-17-provenance.md.
 */
export const contentUlid = (parts: string[], now: number): string =>
  encode(now, createHash("sha256").update(parts.join("\u0000")).digest());

/**
 * Checks a record, with the rules that apply when *reading* one back.
 *
 * Records are immutable and outlive the code that wrote them, so a rule added
 * later must never make an already-stored record unreadable. Tightening the
 * write rule to require a goal or evidence did exactly that: five of this
 * repository's twenty-one records stopped parsing, and `readRecords` dropped
 * them in silence because its catch exists for genuinely corrupt blobs.
 *
 * So the shape rules — envelope version, id, anchor, outcome, timestamp — are
 * enforced on read, and the editorial rule about what makes a record *worth*
 * storing is enforced only on write, by `validateForWrite`.
 */
export function validateRecord(value: unknown): CheckpointRecord {
  const r = value as CheckpointRecord;
  if (!r || typeof r !== "object") throw new Error("Record is not an object");
  if (r.anvc !== ENVELOPE_VERSION) throw new Error(`Unsupported envelope version: ${String(r.anvc)}`);
  if (!ULID.test(r.id ?? "")) throw new Error("Invalid record id; expected ULID");
  if (!r.anchor || !["commit", "blob", "tree"].includes(r.anchor.kind)) throw new Error("Invalid anchor kind");
  if (!OID.test(r.anchor.oid ?? "")) throw new Error("Invalid anchor oid");
  if (!r.session?.run_id || !r.session.agent) throw new Error("Missing session agent or run_id");
  // Both are names, printed on every line that shows a record; a fetched one
  // could otherwise be any object or 60 KiB of text.
  if (typeof r.session.agent !== "string" || r.session.agent.length > 200) throw new Error("session.agent is text, at most 200 characters");
  if (typeof r.session.run_id !== "string" || r.session.run_id.length > 200) throw new Error("session.run_id is text, at most 200 characters");
  if (!r.intent) throw new Error("Missing intent");
  if (r.intent.why !== undefined && typeof r.intent.why !== "string") throw new Error("intent.why must be text");
  if (r.intent.goal !== undefined) {
    if (!r.intent.goal.trim()) throw new Error("intent.goal is empty");
    if (r.intent.goal.length > 200) throw new Error("intent.goal exceeds 200 characters; it is one line, not a summary");
  }
  if (r.intent.prompt !== undefined && Buffer.byteLength(r.intent.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("intent.prompt exceeds 8 KiB");
  }
  if (r.actions && r.actions.length > MAX_ACTIONS) throw new Error("actions exceeds 1000 entries");
  const errors = r.outcome?.errors;
  if (errors) {
    if (errors.length > MAX_ERRORS) throw new Error(`outcome.errors exceeds ${MAX_ERRORS} entries`);
    for (const e of errors) {
      if (Buffer.byteLength(e, "utf8") > MAX_ERROR_BYTES) {
        throw new Error(`an outcome.errors entry exceeds ${MAX_ERROR_BYTES} bytes`);
      }
    }
  }
  if (!r.outcome || !["kept", "abandoned"].includes(r.outcome.status)) throw new Error("Invalid outcome.status");
  if (r.outcome.scope !== undefined) {
    if (!["local", "general"].includes(r.outcome.scope)) throw new Error("outcome.scope must be local or general");
    // A kept attempt has no failure to scope, and letting one carry `general`
    // would make "this approach is dead" readable off a record that worked.
    if (r.outcome.status !== "abandoned") throw new Error("outcome.scope belongs on an abandoned record");
  }
  // `null` says "no command settles this", which is a real answer and a
  // different thing from the field being absent.
  if (r.outcome.recheck !== undefined && r.outcome.recheck !== null) {
    if (typeof r.outcome.recheck !== "string") throw new Error("outcome.recheck must be a string or null");
    if (!r.outcome.recheck.trim()) throw new Error("outcome.recheck is empty");
    if (r.outcome.recheck.length > 300) throw new Error("outcome.recheck exceeds 300 characters; it is one command");
  }
  if (r.evidence !== undefined) {
    if (!Array.isArray(r.evidence)) throw new Error("evidence must be an array");
    if (r.evidence.length > MAX_EVIDENCE) throw new Error(`evidence exceeds ${MAX_EVIDENCE} entries`);
    for (const e of r.evidence) {
      if (!e || typeof e !== "object") throw new Error("an evidence entry is not an object");
      // An entry that addresses nothing is prose with extra steps, which is
      // the shape this field exists to replace.
      if (!e.path && !e.commit) throw new Error("an evidence entry needs a path or a commit");
      if (e.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(e.commit)) throw new Error("evidence.commit is not a git oid");
      if (e.line !== undefined && (!Number.isSafeInteger(e.line) || e.line < 1)) throw new Error("evidence.line is not a line number");
    }
  }
  if (r.authority !== undefined && !["agent", "human"].includes(r.authority)) {
    throw new Error("authority must be agent or human");
  }
  // Bounded generously rather than tightly. The whole point of this field is
  // that disk is not the scarce resource, so the limits exist only to keep one
  // record from eating the 64 KiB envelope and being rejected whole — which is
  // the failure mode that silently loses the most interesting turns.
  if (r.detail !== undefined) {
    if (typeof r.detail !== "object" || r.detail === null) throw new Error("detail must be an object");
    for (const [field, cap] of [["output", MAX_DETAIL_BYTES], ["narrative", MAX_DETAIL_BYTES]] as const) {
      const value = r.detail[field];
      if (value === undefined) continue;
      if (typeof value !== "string") throw new Error(`detail.${field} must be a string`);
      if (Buffer.byteLength(value, "utf8") > cap) throw new Error(`detail.${field} exceeds ${cap} bytes`);
    }
    if (r.detail.ruled_out !== undefined) {
      if (!Array.isArray(r.detail.ruled_out)) throw new Error("detail.ruled_out must be an array");
      if (r.detail.ruled_out.length > MAX_DETAIL_ITEMS) throw new Error(`detail.ruled_out exceeds ${MAX_DETAIL_ITEMS} entries`);
      for (const e of r.detail.ruled_out) {
        // An approach with no reason is the shape this field exists to
        // replace: it tells a reader to avoid something and not why.
        if (!e?.approach || !e?.because) throw new Error("a detail.ruled_out entry needs an approach and a because");
      }
    }
    for (const field of ["not_investigated", "commands"] as const) {
      const value = r.detail[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw new Error(`detail.${field} must be an array`);
      if (value.length > MAX_DETAIL_ITEMS) throw new Error(`detail.${field} exceeds ${MAX_DETAIL_ITEMS} entries`);
    }
  }
  for (const [field, value] of [["parent", r.parent], ["serves", r.serves], ["supersedes", r.supersedes]] as const) {
    if (value !== undefined && !ULID.test(value)) throw new Error(`${field} is not a record id`);
    // A record pointing at itself makes lineage walks non-terminating, and
    // nothing downstream checks for it.
    if (value !== undefined && value === r.id) throw new Error(`${field} points at its own record`);
  }
  if (r.retires !== undefined) {
    const t = r.retires;
    if (!ULID.test(t.id ?? "")) throw new Error("retires.id is not a record id");
    if (t.id === r.id) throw new Error("retires points at its own record");
    if (!["proposed", "retired", "declined", "restored"].includes(t.state)) throw new Error("retires.state must be proposed, retired, declined or restored");
    if (!Object.hasOwn(RETIRE_REASONS, t.reason)) throw new Error(`retires.reason must be one of ${Object.keys(RETIRE_REASONS).join(", ")}`);
    if (typeof t.evidence !== "string" || !t.evidence.trim()) throw new Error("retires.evidence is required: say what you saw");
    if (t.evidence.length > 2000) throw new Error("retires.evidence exceeds 2000 characters");
    if (t.by !== undefined && !ULID.test(t.by)) throw new Error("retires.by is not a record id");
  }
  if (r.result !== undefined) validateResult(r);
  if (r.objective !== undefined) validateObjective(r);
  if (r.rule !== undefined) validateRule(r);
  if (r.tool_note !== undefined) {
    const n = r.tool_note;
    if (typeof n.tool !== "string" || !n.tool.trim() || n.tool.length > MAX_TOOL_NAME || /\s/.test(n.tool)) throw new Error(`tool_note.tool is one word, at most ${MAX_TOOL_NAME} characters`);
    if (typeof n.when !== "string" || !n.when.trim() || n.when.length > MAX_NOTE) throw new Error(`tool_note.when is required, at most ${MAX_NOTE} characters`);
    if (n.of !== undefined && (!ULID.test(n.of) || n.of === r.id)) throw new Error("tool_note.of is not another record's id");
  }
  if (r.status_item !== undefined) {
    const x = r.status_item;
    if (!x || typeof x.title !== "string" || !x.title.trim() || x.title.length > 200) throw new Error("status_item.title is required, at most 200 characters");
    if (!ITEM_STATES.includes(x.state)) throw new Error(`status_item.state must be one of ${ITEM_STATES.join(", ")}`);
    for (const [field, value] of [["goal", x.goal], ["of", x.of]] as const) {
      if (value !== undefined && (!ULID.test(value) || value === r.id)) throw new Error(`status_item.${field} is not another record's id`);
    }
    if (x.rank !== undefined && !Number.isFinite(x.rank)) throw new Error("status_item.rank is a number");
  }
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.ts ?? "")) throw new Error("Invalid ts; expected RFC 3339 UTC");
  if (Buffer.byteLength(canonical(r), "utf8") > MAX_RECORD_BYTES) throw new Error("Record exceeds 64 KiB");
  return r;
}

export type ResultStatus = "draft" | "current" | "locked" | "superseded" | "invalid";
export const RESULT_STATUSES: readonly ResultStatus[] = ["draft", "current", "locked", "superseded", "invalid"];

/** Whether a path starts at a root or a drive, or climbs out with .., on any system a record may be read on. */
const outside = (p: string) => /^([\\/]|[A-Za-z]:)/.test(p) || p.split(/[\\/]/).includes("..");
const relativePath = (p: unknown) => typeof p === "string" && p.length > 0 && p.length <= 400 && !outside(p);

function validateResult(r: CheckpointRecord): void {
  const x = r.result!;
  if (typeof x.name !== "string" || !x.name.trim() || x.name.length > 120) throw new Error("result.name is required, at most 120 characters");
  if (x.value !== undefined && (typeof x.value !== "string" || x.value.length > 80)) throw new Error("result.value is text, at most 80 characters");
  if (x.of === undefined && x.value === undefined) throw new Error("result.value is required: the value as it is written where it is used");
  if (!RESULT_STATUSES.includes(x.status)) throw new Error(`result.status must be one of ${RESULT_STATUSES.join(", ")}`);
  for (const [field, value] of [["of", x.of], ["replaces", x.replaces]] as const) {
    if (value !== undefined && !ULID.test(value)) throw new Error(`result.${field} is not a record id`);
    if (value !== undefined && value === r.id) throw new Error(`result.${field} points at its own record`);
  }
  if (x.part !== undefined && (typeof x.part !== "string" || x.part.length > 80)) throw new Error("result.part is at most 80 characters");
  if (x.source !== undefined && !relativePath(x.source.path)) throw new Error("result.source.path must be a path inside the repository");
  if (x.command !== undefined && (typeof x.command !== "string" || x.command.length > 1000)) throw new Error("result.command is at most 1000 characters");
  if (x.settings !== undefined) {
    const entries = Object.entries(x.settings);
    if (entries.length > 50 || entries.some(([k, v]) => k.length > 80 || typeof v !== "string" || v.length > 200)) {
      throw new Error("result.settings holds at most 50 short text values");
    }
  }
  if (x.depends !== undefined && (!Array.isArray(x.depends) || x.depends.length > 50 || x.depends.some((d) => !relativePath(d.path)))) {
    throw new Error("result.depends lists at most 50 paths inside the repository");
  }
  if (x.derived_from !== undefined && (!Array.isArray(x.derived_from) || x.derived_from.length > 50 || x.derived_from.some((id) => !ULID.test(id)))) {
    throw new Error("result.derived_from lists at most 50 record ids");
  }
  if (x.used_in !== undefined && (!Array.isArray(x.used_in) || x.used_in.length > 20 || x.used_in.some((u) => typeof u !== "string" || u.length > 200))) {
    throw new Error("result.used_in lists at most 20 short places");
  }
}

export type GoalStatus = "todo" | "doing" | "done" | "dropped";
export const GOAL_STATUSES: readonly GoalStatus[] = ["todo", "doing", "done", "dropped"];
export type ItemState = "next" | "doing" | "done" | "dropped";
export const ITEM_STATES: readonly ItemState[] = ["next", "doing", "done", "dropped"];

function validateObjective(r: CheckpointRecord): void {
  const x = r.objective!;
  if (!x || typeof x !== "object") throw new Error("objective must be an object");
  if (typeof x.title !== "string" || !x.title.trim() || x.title.length > 200) throw new Error("objective.title is required, at most 200 characters");
  if (!GOAL_STATUSES.includes(x.status)) throw new Error(`objective.status must be one of ${GOAL_STATUSES.join(", ")}`);
  if (x.proposed !== undefined && x.proposed !== true) throw new Error("objective.proposed is true or left out");
  for (const [field, value] of [["parent", x.parent], ["of", x.of]] as const) {
    if (value !== undefined && !ULID.test(value)) throw new Error(`objective.${field} is not a record id`);
    if (value !== undefined && value === r.id) throw new Error(`objective.${field} points at its own record`);
  }
}

/** A file a rule set's text can be read from: Markdown or plain text. */
export const RULE_FILE = /\.(md|markdown|mdx|mdc|txt|rst)$/i;

function validateRule(r: CheckpointRecord): void {
  const x = r.rule!;
  if (!x || typeof x !== "object") throw new Error("rule must be an object");
  if (typeof x.name !== "string" || !x.name.trim() || x.name.length > 80) throw new Error("rule.name is required, at most 80 characters");
  if (x.of !== undefined && (!ULID.test(x.of) || x.of === r.id)) throw new Error("rule.of is not another record's id");
  if (x.removed !== undefined && x.removed !== true) throw new Error("rule.removed is true or absent");
  if (x.removed) {
    if (!x.of) throw new Error("a removal names the rule set it removes in rule.of");
    return;
  }
  // A glob is matched against repository-relative paths, so one that starts
  // at / or climbs out with .. can never match anything.
  if (!Array.isArray(x.applies) || !x.applies.length || x.applies.length > 20
    || x.applies.some((a) => typeof a !== "string" || !a.trim() || a.length > 200 || outside(a))) {
    throw new Error("rule.applies lists 1 to 20 globs inside the repository, or commit");
  }
  if ((x.source === undefined) === (x.text === undefined)) throw new Error("a rule set has a source or a text, not both");
  if (x.source !== undefined) {
    if (!relativePath(x.source?.path)) throw new Error("rule.source.path must be a path inside the repository");
    // Rules are prose. Any other file could be .env, and a fetched record
    // naming it would put its contents in front of the agent.
    if (!RULE_FILE.test(x.source.path)) throw new Error("rule.source.path must be a Markdown or text file");
    const h = x.source.heading;
    if (h !== undefined && (typeof h !== "string" || !h.trim() || h.length > 200)) throw new Error("rule.source.heading is text, at most 200 characters");
  }
  if (x.text !== undefined && (typeof x.text !== "string" || !x.text.trim() || Buffer.byteLength(x.text, "utf8") > 8 * 1024)) {
    throw new Error("rule.text is at most 8 KiB");
  }
}

/** Stable key order so the same record always hashes to the same blob. */
export function canonical(record: CheckpointRecord): string {
  // Every field the envelope can carry has to be listed here: a key missing
  // from this order is silently dropped from the blob, so the record that gets
  // stored is not the record that was validated.
  //
  // The verdict comes before the evidence, and the bulky `actions` list goes
  // last. Measured on this repository before the change: `outcome` sat at a
  // median of 93.9% and a maximum of 99.7% through each record, so anything
  // reading the first half saw an approach and the commands that ran it and
  // never reached "…and it was abandoned". That is worse than no record: it
  // reads as a description of how to do the thing.
  //
  // Readers that stop early are the normal case rather than the exception —
  // agents grep, read the first lines, and conclude — so the first bytes have
  // to be true on their own even if nothing after them is read.
  const order = ["anvc", "id", "outcome", "intent", "anchor", "delta", "evidence",
    "parent", "serves", "supersedes", "map", "retires", "result", "objective", "rule", "tool_note", "status_item", "session", "actions", "authority", "detail", "ts", "truncated"];
  const source = record as unknown as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of order) if (source[key] !== undefined) sorted[key] = source[key];
  return JSON.stringify(sorted);
}

/**
 * Where a record lives, and so who can read it.
 *
 * Shared records travel with the repository: `git push` sends them and a
 * teammate's fetch brings them in. Private records stay on the machine that
 * wrote them. They are still read by every query and every injection here —
 * private means unshared, not unused.
 */
export type Tier = "private" | "shared";
export const TIER_PREFIX: Record<Tier, string> = { shared: "refs/anvc/", private: "refs/anvc-private/" };

export const tierOf = (ref: string): Tier => (ref.startsWith(TIER_PREFIX.private) ? "private" : "shared");

/**
 * The tier a record goes to when the writer does not say.
 *
 * Set in settings (`anvc policy tier private`), or by the older
 * `git config anvc.tier private` when no settings were chosen.
 */
export function defaultTier(repo: string): Tier {
  // A choice made in settings wins. git config is read only when nothing was
  // chosen, for anyone who set it before the policy existed; letting it win
  // made the settings page show one answer while records went elsewhere.
  if (isLocalOnly(repo)) return "private";
  const policy = readPolicy(repo);
  if (policy.chosen) return policy.tier;
  const configured = gitOrNull(repo, ["config", "--get", "anvc.tier"]);
  if (configured === "private" || configured === "shared") return configured;
  return policy.tier;
}

export function refFor(sessionId: string, seq: number, tier: Tier = "shared"): string {
  const session = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "");
  if (!SESSION.test(session)) throw new Error(`Invalid session id: ${sessionId}`);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid sequence");
  return `${TIER_PREFIX[tier]}${session}/${String(seq).padStart(6, "0")}`;
}

/**
 * The version of a record that is fit to leave this machine.
 *
 * Two things change and nothing else. Paths inside the repository become
 * repository-relative and the home directory becomes `~`, because an absolute
 * path names a person and a machine and is useless on anyone else's. And
 * `intent.prompt` goes: what a person typed is theirs, and it stays in the
 * private tier even when the record built from it is shared.
 *
 * Walked over every string rather than a list of known path fields, since a
 * path turns up in commands, command output and error text as often as in
 * `actions[].path`, and a list would be out of date the day a field is added.
 */
export function portable(record: CheckpointRecord, repo: string, home = homedir()): CheckpointRecord {
  const hasHome = Boolean(home) && home !== "/";
  const repoAt = windowsPath(repo), homeAt = hasHome ? windowsPath(home) : null;
  const out = eachString(record, (value) => {
    let out = value;
    if (repoAt) {
      out = out.replace(new RegExp(`${repoAt}[\\\\/]+`, "gi"), "");
      if (new RegExp(`^${repoAt}$`, "i").test(out)) out = ".";
    } else {
      out = out.split(`${repo}/`).join("");
      if (out === repo) out = ".";
    }
    if (homeAt) out = out.replace(new RegExp(homeAt, "gi"), "~");
    else if (hasHome) out = out.split(`${home}/`).join("~/").split(home).join("~");
    return out;
  });
  if (out.intent?.prompt !== undefined) {
    const { prompt: _dropped, ...intent } = out.intent;
    out.intent = intent;
  }
  return out;
}

/**
 * On Windows, one absolute path as a pattern for every way it turns up in
 * what programs write: \ or / between its folders, doubled as in JSON too,
 * any case, since Windows reads C:\Users and c:\users as one folder, and Git
 * Bash's /c/ for the drive. Null elsewhere, where a path is written one way.
 */
function windowsPath(path: string): string | null {
  const m = process.platform === "win32" ? /^([A-Za-z]):[\\/]+(.*)$/.exec(path) : null;
  if (!m) return null;
  const folders = m[2]!.split(/[\\/]+/).filter(Boolean).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(?:${m[1]}:|/${m[1]})${folders.map((f) => `[\\\\/]+${f}`).join("")}`;
}

/** A copy with every string passed through `fn`, except under the keys in `skip`. */
function eachString<T>(value: T, fn: (s: string) => string, skip = new Set<string>()): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skip.has(k) ? x : walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Ids, object ids and times: formats the validator checks, and never text anyone wrote. */
const NOT_TEXT = new Set(["id", "anchor", "session", "ts", "parent", "serves", "supersedes", "by", "of", "replaces", "derived_from", "commit", "hash"]);

/**
 * The record with every named credential shape redacted from what was
 * written in it.
 *
 * The raw log was scrubbed at capture, but what an agent passed to a tool went
 * into a record as it was sent, and a shared record goes out with the next
 * push. This runs where every record is written, so no caller has to remember.
 */
const redacted = (record: CheckpointRecord): CheckpointRecord => eachString(record, redactSecrets, NOT_TEXT);

/** The all-zero object id, which `update-ref` reads as "this ref must not exist". */
const ABSENT = "0".repeat(40);

/**
 * The stricter rule for new records: say something, or do not be written.
 *
 * Either the agent stated a goal — the good case, and the point of the
 * product — or the record carries evidence of what happened: files it changed,
 * or commands that failed. A captured prompt is deliberately not enough,
 * because storing the user's words made the log read "just continue until u
 * need me", which describes nothing a reader can act on later.
 *
 * Kept separate from `validateRecord` so that raising the bar for new records
 * never retroactively unreads old ones.
 */
export function validateForWrite(record: CheckpointRecord): CheckpointRecord {
  const r = validateRecord(record);
  const hasGoal = typeof r.intent.goal === "string";
  const hasEvidence = (r.delta?.files?.length ?? 0) > 0 || (r.outcome.errors?.length ?? 0) > 0;
  if (!hasGoal && !hasEvidence) {
    throw new Error("A record needs intent.goal, or evidence (delta.files or outcome.errors)");
  }
  // An abandoned attempt has to say how it could be checked.
  //
  // Measured on this repository: `recheck` was optional and filled in 0 of 33
  // records, including 0 of the 2 abandoned ones — by the agent that added the
  // field, repeatedly, while writing the comments explaining why it mattered.
  // An optional field carrying the whole verification story is a field that
  // does not exist.
  //
  // The reason to force this one and not the others: a prohibition decays with
  // distance from where it was stated, while an instruction to run something
  // does not, so "do not retry X" degrades into noise and "run this to find
  // out" does not. And a verdict a reader cannot test is worse than silence
  // when the original diagnosis was wrong.
  //
  // `null` is a legitimate answer — some failures genuinely have no command
  // that settles them — but it has to be stated rather than left out, because
  // the omission is what made the field vanish.
  if (r.outcome.status === "abandoned" && r.outcome.recheck === undefined && r.intent.goal) {
    throw new Error(
      "An abandoned record needs outcome.recheck: one command that tells a later reader whether this is still true. "
      + "Pass null if no command settles it.");
  }
  return r;
}

/**
 * Which part of a record each policy field names.
 *
 * Kept next to the record shape so a field added to one without the other
 * shows up here, in one place.
 */
const FIELD_PATHS: Array<[Field, (r: CheckpointRecord) => void]> = [
  ["why", (r) => { if (r.intent) delete r.intent.why; }],
  ["errors", (r) => { delete r.outcome.errors; }],
  ["files", (r) => { delete r.delta; }],
  ["evidence", (r) => { delete r.evidence; }],
  // `null` rather than absent: the write rules require an abandoned record to
  // answer, and "not kept here" is an answer; absence would read as forgotten.
  ["recheck", (r) => { if (r.outcome.recheck !== undefined) r.outcome.recheck = null; }],
  ["steps", (r) => { delete r.actions; if (r.detail) delete r.detail.commands; }],
  ["detail_output", (r) => { if (r.detail) delete r.detail.output; }],
  ["narrative", (r) => { if (r.detail) delete r.detail.narrative; }],
  ["ruled_out", (r) => { if (r.detail) delete r.detail.ruled_out; }],
  ["not_investigated", (r) => { if (r.detail) delete r.detail.not_investigated; }],
  ["maps", (r) => { delete r.map; }],
];

/** A copy with every field whose choice is in `drop` removed. */
function without(record: CheckpointRecord, fields: Record<string, string>, drop: string[]): CheckpointRecord {
  const out = structuredClone(record);
  for (const [field, remove] of FIELD_PATHS) if (drop.includes(fields[field] ?? "shared")) remove(out);
  if (out.detail && !Object.keys(out.detail).length) delete out.detail;
  return out;
}

/** A record as a shared write stores it: without what the policy keeps private or off, and fit to leave this machine. */
const forSharing = (repo: string, record: CheckpointRecord, fields: Record<string, string>): CheckpointRecord =>
  portable(without(redacted(record), fields, ["private", "off"]), repo);

/** A record's canonical blob, written to the object database. */
const blobOf = (repo: string, record: CheckpointRecord) => git(repo, ["hash-object", "-w", "--stdin"], { input: canonical(record) });

/** Puts an object at the next free sequence of a session in a tier, or null when fifty in a row were taken. No rules applied. */
function place(repo: string, session: string, oid: string, tier: Tier): { ref: string; oid: string } | null {
  let seq = nextSeq(repo, session, tier);
  for (let i = 0; i < 50; i++, seq++) {
    const ref = refFor(session, seq, tier);
    if (gitOrNull(repo, ["update-ref", ref, oid, ABSENT]) !== null) return { ref, oid };
  }
  return null;
}

/**
 * Writes one record as an immutable ref, obeying the project's policy.
 *
 * Refuses to overwrite: a ref that exists is never updated, only added to, so
 * a correction is a new record whose `parent` names the one it supersedes.
 *
 * Creation is atomic. Checking with `rev-parse` and then calling `update-ref`
 * looked equivalent but was a race: between the two commands another writer
 * could take the ref, and a bare `update-ref` overwrites without complaint. Ten
 * agents checkpointing one session concurrently were all told "recorded" while
 * nine records were silently destroyed. Passing the expected old value makes
 * git do the compare-and-swap under its own ref lock, so a loser fails loudly
 * instead of clobbering the winner.
 *
 * Fields set to off are not saved anywhere. When the record is shared, fields
 * set to private are left out of the shared copy and the full record is kept
 * in the private tier under the same id — so the team gets the decision and
 * this machine keeps the evidence behind it.
 */
export function writeRecord(repo: string, record: CheckpointRecord, seq: number, tier: Tier = "shared"): { ref: string; oid: string } {
  // The rules for a new record are checked on what the agent wrote, before
  // the policy removes anything, so a choice to keep less is never mistaken
  // for a record that said too little.
  validateForWrite(record);
  const policy = readPolicy(repo);
  const full = redacted(without(record, policy.fields, ["off"]));
  validateRecord(full);

  const put = (r: CheckpointRecord) => {
    const ref = refFor(r.session.run_id, seq, tier);
    const oid = blobOf(repo, r);
    if (gitOrNull(repo, ["update-ref", ref, oid, ABSENT]) === null) throw new Error(`Refusing to overwrite immutable ref ${ref}`);
    return { ref, oid };
  };
  if (tier === "private") return put(full);

  // A shared record is written in the form it will be read in elsewhere, so no
  // later step has to remember to clean it before it travels.
  const stored = forSharing(repo, full, policy.fields);
  validateRecord(stored);
  const written = put(stored);
  // Something was held back from the shared copy: keep the whole record here.
  if (canonical(portable(full, repo)) !== canonical(stored)
    && !place(repo, full.session.run_id, blobOf(repo, full), "private")) {
    throw new Error(`could not place a record for ${full.session.run_id} in the private tier`);
  }
  return written;
}

/**
 * Writes a record at the next free sequence, retrying when another writer takes
 * it first. `nextSeq` reads and `writeRecord` writes, so on a shared repository
 * the sequence it returns can be claimed before this writer uses it; that is
 * not an error, it just means trying again with a fresh number.
 */
export function appendRecord(
  repo: string,
  record: CheckpointRecord,
  opts: { tier?: Tier } = {},
): { ref: string; oid: string } {
  // Local only is a guarantee, so it is kept here, where every record passes:
  // whatever the caller asked for, nothing written meanwhile can be pushed.
  const tier = isLocalOnly(repo) ? "private" : opts.tier ?? "shared";
  const attempts = 50;
  let seq = nextSeq(repo, record.session.run_id, tier);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return writeRecord(repo, record, seq, tier);
    } catch (error) {
      last = error;
      // Only a lost race is worth retrying; a malformed record fails forever.
      if (!(error instanceof Error) || !error.message.includes("Refusing to overwrite")) throw error;
      // Step past the sequence that was taken rather than re-reading the same
      // one: every writer would otherwise recompute an identical `nextSeq` and
      // collide on it again, so heavy contention exhausted the attempts.
      seq++;
    }
  }
  throw new Error(`could not claim a sequence for ${record.session.run_id} after ${attempts} attempts: ${
    last instanceof Error ? last.message : String(last)}`);
}

export function readRecord(repo: string, ref: string): CheckpointRecord {
  return validateRecord(JSON.parse(git(repo, ["cat-file", "blob", ref])));
}

/** Written here, or fetched from a teammate by the refspec `anvc init` sets. */
export const isRecordRef = (ref: string): boolean =>
  ref.startsWith(TIER_PREFIX.shared) || ref.startsWith(TIER_PREFIX.private)
  || /^refs\/remotes\/[^/]+\/anvc\//.test(ref);

/**
 * Every record, local and fetched.
 *
 * A teammate's records arrive under `refs/remotes/<remote>/anvc/`, kept apart
 * so they cannot pass for ones written here. Reading only `refs/anvc/` meant
 * they were fetched and then never read: no query, no injection and no page
 * saw them, and the distribution test passed because it counted refs rather
 * than asking whether anything used them.
 *
 * A record pushed and fetched back exists under both names with one blob, so
 * the local ref wins and the copy is dropped by object id.
 */
export function listRecords(repo: string): Array<{ ref: string; oid: string }> {
  const local = readRefs(repo, TIER_PREFIX.shared);
  // Private records are read like any other. Private means unshared, not
  // hidden from the agent working on this machine.
  const mine = readRefs(repo, TIER_PREFIX.private);
  const fetched = readRefs(repo, "refs/remotes/").filter(({ ref }) => isRecordRef(ref));
  // One ref per object, a ref written here preferred over a fetched copy.
  const byOid = new Map<string, { ref: string; oid: string }>();
  for (const r of [...fetched, ...local, ...mine]) byOid.set(r.oid, r);
  const kept = new Set(byOid.values());
  // Ordered fetched, then shared, then private, because the index keeps the
  // last record it reads for an id: a full private copy must win over the
  // shared copy it was held back from, and anything written here over a
  // fetched copy of it.
  return [...fetched, ...local, ...mine].filter((r) => kept.has(r) && kept.delete(r));
}

/**
 * Reads every record in one git process instead of one process per record.
 *
 * `readRecord` spawns `cat-file` per ref, which is fine for one record and
 * quadratic-feeling for a log: measured at 5,000 records, per-ref reads took
 * 2,727 ms and one `cat-file --batch` took 71 ms — 38x, and the gap grows with
 * the log. Since the index is rebuilt from refs on every query, that cost was
 * paid on every query: 6 seconds at 10,000 records, which no agent will wait
 * for before starting work.
 *
 * Yields `[ref, record]` and skips anything unparseable, because one corrupt
 * blob must not cost the caller every other record.
 */
export function readRecords(repo: string, refs = listRecords(repo)): Array<[string, CheckpointRecord]> {
  if (!refs.length) return [];
  // `--batch` answers each oid with "<oid> <type> <size>\n<payload>\n", so the
  // payload is framed by a byte count rather than delimited — a record
  // containing a newline cannot desynchronise the stream.
  // Read as bytes, not as a string. The size git reports is a byte count, and
  // slicing a decoded string by it desynchronises the whole stream the moment
  // a record contains a non-ASCII character — one em-dash in a `why` field
  // made every following record unparseable, and they were dropped in silence.
  const result = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: refs.map((r) => r.oid).join("\n") + "\n",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git cat-file failed: ${String(result.stderr ?? "").trim()}`);
  const out: Buffer = result.stdout;

  const records: Array<[string, CheckpointRecord]> = [];
  let pos = 0;
  for (const { ref } of refs) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const size = Number(out.toString("utf8", pos, nl).split(" ")[2]);
    // "<oid> missing" has no size and no payload: a fetched ref whose blob a
    // shallow fetch or a gc never left here. Only that record is skipped.
    if (!Number.isFinite(size)) { pos = nl + 1; continue; }
    const body = out.toString("utf8", nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    try { records.push([ref, validateRecord(JSON.parse(body))]); } catch { /* skip, as readRecord's callers do */ }
  }
  return records;
}

/** Next free sequence for a session, so an emitter can resume after a restart. */
export function nextSeq(repo: string, sessionId: string, tier: Tier = "shared"): number {
  const prefix = refFor(sessionId, 1, tier).replace(/\/\d+$/, "");
  const out = git(repo, ["for-each-ref", "--format=%(refname)", `${prefix}/`]);
  if (!out) return 1;
  // Ignore refs whose last segment is not a sequence. One stray ref — a backup,
  // a mirror's refspec — used to make Math.max return NaN, and every later
  // write for that session failed with "Invalid sequence" forever after.
  const seqs = out.split("\n")
    .map((r) => Number(r.split("/").pop()))
    .filter((n) => Number.isSafeInteger(n) && n >= 1);
  return seqs.length ? Math.max(...seqs) + 1 : 1;
}

/**
 * Moves a record between tiers. Returns the new ref.
 *
 * Sharing writes what a shared write would have stored under `refs/anvc/` and
 * only then removes the private ref, so a failure part-way leaves the record
 * where it was rather than nowhere. The record keeps its id: it is the same
 * claim, now readable by more people, and a record that superseded it still
 * points at it. When the policy held something back, the private ref stays,
 * as it does for a shared write: sharing an ingested record published its
 * steps and full output while it only made paths portable.
 *
 * Unsharing moves it back here. It cannot unpublish a record already pushed —
 * a remote's copy is the remote's — and says so rather than implying it can.
 */
export function moveRecord(repo: string, ref: string, to: Tier): { ref: string; oid: string; pushed: boolean } {
  if (!ref.startsWith(TIER_PREFIX.shared) && !ref.startsWith(TIER_PREFIX.private)) {
    throw new Error(`${ref} is not a record written here; a teammate's record cannot be moved`);
  }
  if (tierOf(ref) === to) throw new Error(`${ref} is already ${to}`);
  if (to === "shared" && isLocalOnly(repo)) throw new Error(LOCAL_ONLY_REFUSAL);
  const oid = gitOrNull(repo, ["rev-parse", "--verify", "--quiet", ref]);
  if (!oid) throw new Error(`no such record: ${ref}`);
  const record = readRecord(repo, ref);
  // Placed, not re-written. The rules in validateForWrite decide what a *new*
  // record must carry, and records written before a rule existed fail it — five
  // of this repository's nineteen scraped records did, and stayed in the shared
  // tier. Moving a record is not writing one, so only its shape is checked.
  const stored = to === "shared" ? forSharing(repo, record, readPolicy(repo).fields) : record;
  validateRecord(stored);
  const written = place(repo, record.session.run_id, to === "private" ? oid : blobOf(repo, stored), to);
  if (!written) throw new Error(`could not place ${ref} in the ${to} tier`);
  // Compare-and-delete: if another writer moved this ref meanwhile, leave it.
  if (to === "private" || canonical(portable(record, repo)) === canonical(stored)) git(repo, ["update-ref", "-d", ref, oid]);
  const upstream = to === "private"
    && Boolean(gitOrNull(repo, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/anvc/${ref.slice(TIER_PREFIX.shared.length)}`]));
  return { ...written, pushed: upstream };
}

/**
 * A record id, or a full ref, resolved to the ref written here, in `tier` if
 * given.
 *
 * One id can have several refs: a shared record keeps its full copy private,
 * and unsharing it adds another. The last one is the one every query reads,
 * in the order listRecords gives. Taking the first moved the older full copy
 * after an unshare and a share, and left the newer copy behind as a duplicate.
 */
export function findRecordRef(repo: string, idOrRef: string, tier?: Tier): string | null {
  if (idOrRef.startsWith("refs/")) return idOrRef;
  const refs = tier ? readRefs(repo, TIER_PREFIX[tier]) : [...readRefs(repo, TIER_PREFIX.shared), ...readRefs(repo, TIER_PREFIX.private)];
  let found: string | null = null;
  for (const [ref, record] of readRecords(repo, refs)) if (record.id === idOrRef) found = ref;
  return found;
}
