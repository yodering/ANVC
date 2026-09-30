/**
 * Turns captured hook events into checkpoint records.
 *
 * The emitter writes raw per-event JSONL; this groups those events into one
 * record per prompt-turn and seals it with an outcome. Abandonment is decided
 * here, at seal time, by asking whether the files a turn wrote survived into
 * the anchor's history — see spec/anvc-checkpoint-v0.md.
 */
import { gitOrNull } from "./git";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { appendRecord, canonical, contentUlid, readRecords, MAX_RECORD_BYTES, type Action, type CheckpointRecord } from "./record";
import { shellPaths } from "./shell-paths";
import { headTail, inRepo, isRepo } from "./rawlog";

export interface CaptureEvent {
  anvc_capture: 0;
  event: string;
  ts: string;
  session_id: string | null;
  /** Which agent's hook wrote this. Absent in rows from before agents other than Claude Code. */
  agent?: string;
  /** The agent's own session file, so a later session can be pointed at it. */
  transcript?: string | null;
  cwd: string;
  repo: string | null;
  tool: string | null;
  path: string | null;
  bytes: number | null;
  command: string | null;
  prompt: string | null;
  ok: boolean | null;
  /** What the command printed, scrubbed and trimmed by shape at capture time. */
  output?: string | null;
  /** Files a shell command named as its outputs, and other files it named, fingerprinted (protocol/runs.ts). */
  outputs?: Array<{ path: string; hash: string; bytes: number }>;
  inputs?: Array<{ path: string; hash: string; bytes: number }>;
  /** What a `Task` delegation was for, in the parent agent's own words. */
  delegated?: string | null;
  /** Which kind of subagent it was handed to. */
  agent_type?: string | null;
  /** The subagent a row is from, or whose start or stop it is. */
  agent_id?: string;
  /** On a SubagentStart row: the parent's call that started it, so another start doesn't claim it. */
  tool_use_id?: string;
}

/** The tool a call hands work to a subagent with. Claude Code called it Task, and now calls it Agent. */
export const DELEGATE_TOOLS = new Set(["Task", "Agent"]);

export function readCapture(path: string): CaptureEvent[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as CaptureEvent)
    .filter((e) => e.anvc_capture === 0);
}

/** Paths still differing from HEAD, i.e. not yet committed anywhere. */
function uncommitted(repo: string): Set<string> {
  // Names only. Porcelain status puts a two-letter code before each path, and
  // the output is trimmed, so the first path's leading space went with it and
  // " M a.ts" was read as ".ts": the first changed file never counted.
  const changed = gitOrNull(repo, ["diff", "--name-only", "-z", "HEAD"]) ?? "";
  const added = gitOrNull(repo, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
  return new Set(`${changed}\0${added}`.split("\0").filter(Boolean));
}

/**
 * Groups events into turns. A turn starts at a UserPromptSubmit and ends at the
 * next one, so `intent.prompt` is the instruction that actually caused the
 * actions attributed to it.
 */
export function toRecords(
  events: CaptureEvent[],
  repo: string,
  /** Session id to the times the agent checkpointed in it; see below. */
  checkpoints: Map<string, number[]> = new Map(),
  /**
   * The session just ended. Uncommitted files then mean work in progress,
   * not work that never reached history, so only a turn whose files are
   * all back as they were counts as abandoned.
   */
  opts: { fresh?: boolean } = {},
): CheckpointRecord[] {
  // Split per session before splitting on prompts. One global stream assumes
  // one agent: with two working at once their events interleave, and a prompt
  // from either one closed whatever turn was open. Measured on a four-event
  // fixture, two agents collapsed into a single record attributed to one of
  // them and claiming both their files — the other agent disappeared.
  //
  // An event with no session id is quarantined rather than folded into
  // whichever turn happens to be open, because guessing its owner is how one
  // agent's work ends up recorded as another's.
  const bySession = Map.groupBy(events.filter((e) => e.session_id), (e) => e.session_id!);

  // Each turn runs until the session's next prompt, or forever if it was the last.
  const turns: Array<{ events: CaptureEvent[]; until: number }> = [];
  for (const stream of bySession.values()) {
    // By time, not file order: a Cursor print-mode prompt is written at the
    // end of the session, stamped before the commands it caused.
    stream.sort((a, b) => a.ts.localeCompare(b.ts));
    let current: CaptureEvent[] = [];
    for (const event of stream) {
      if (event.event === "UserPromptSubmit" && current.length) {
        turns.push({ events: current, until: Date.parse(event.ts) });
        current = [];
      }
      current.push(event);
    }
    if (current.length) turns.push({ events: current, until: Infinity });
  }

  const head = gitOrNull(repo, ["rev-parse", "HEAD"]);
  const dirty = uncommitted(repo);
  const toRepo = inRepo(repo);
  const records: CheckpointRecord[] = [];

  for (const { events: turn, until } of turns) {
    // A turn still has to be *delimited* by a prompt — that is what separates
    // one unit of work from the next — but the prompt's text is not stored.
    const prompt = turn.find((e) => e.prompt)?.prompt;
    if (!prompt) continue;
    // Known by construction: turns are built from per-session streams.
    const session = turn[0]!.session_id!;

    // The agent already recorded this turn with anvc_checkpoint. A scraped
    // record beside it showed the same attempt twice in the work log, once
    // titled by the agent and once as "Changed greet.ts". The agent's record
    // wins because it says why; the raw events stay in the capture log.
    const from = Date.parse(turn[0]!.ts);
    if (checkpoints.get(session)?.some((t) => t >= from && t < until)) continue;

    const actions: Action[] = [];
    const written = new Set<string>();
    /** Written paths read out of shell commands rather than named by a tool. */
    const guessed = new Set<string>();
    // `ok` is the only failure signal a scraped turn has. Without it a turn
    // that ran nothing but failing commands recorded no errors at all.
    const failures: string[] = [];
    /**
     * Work this turn handed to a subagent.
     *
     * A delegated agent does real work — reads, edits, decisions — and none of
     * it reaches this log. It runs in its own context, never calls
     * `anvc_checkpoint` because it does not know we exist, and its events
     * arrive under the parent's session id if they arrive at all. Measured on
     * this repository in one day: 902 captured events, one session id, seven
     * subagents.
     *
     * The parent's one-line description of the task is the only account of it
     * that exists. Thin, and better than the silence it replaces.
     */
    const delegations: string[] = [];
    /** Verbatim output of whatever failed this turn, for the dense half. */
    const outputs: string[] = [];
    for (const event of turn) {
      if (event.tool && DELEGATE_TOOLS.has(event.tool) && event.delegated) {
        delegations.push(event.agent_type ? `${event.delegated} (${event.agent_type})` : event.delegated);
        continue;
      }
      if (event.tool === "Read" && event.path) actions.push({ kind: "read", path: event.path, ts: event.ts });
      else if (event.path && (event.tool === "Edit" || event.tool === "Write" || event.tool === "NotebookEdit")) {
        actions.push({ kind: "write", path: event.path, bytes: event.bytes ?? undefined, ts: event.ts });
        written.add(event.path);
      } else if (event.tool === "Bash" && event.command) {
        actions.push({ kind: "shell", command: event.command.slice(0, 512), ts: event.ts });
        if (event.ok === false) {
          failures.push(`failed: ${event.command.slice(0, 200)}`);
          // What actually printed, not a paraphrase of it. A scraped record
          // could previously say only that a command failed, which is the one
          // thing a reader can already guess; the output is what settles
          // whether the diagnosis drawn from it was right.
          if (event.output) outputs.push(`$ ${event.command.slice(0, 200)}\n${event.output}`);
        }
        // An agent editing through the shell never calls Read or Edit, so
        // without this the record misses most file activity on this project.
        // After a cd, a relative path is relative to somewhere this log doesn't
        // know: "cd ~/notes && sed -i ... MEMORY.md" was recorded as this
        // repository's MEMORY.md, a file it never had.
        const moved = /(^|[;&|]\s*)cd\s/.test(event.command);
        for (const { path, kind } of shellPaths(event.command)) {
          if (moved && !isAbsolute(path)) continue;
          const absolute = isAbsolute(path) ? path : join(event.cwd, path);
          actions.push({ kind, path: absolute, ts: event.ts });
          if (kind === "write") { written.add(absolute); guessed.add(absolute); }
        }
      }
    }

    /**
     * Only files inside the repository.
     *
     * A turn commonly writes somewhere else — a scratch file in /tmp, the
     * agent's own notes under ~/.claude — and those are not this project's
     * history. Keeping them was also silently wrong twice over: the path went
     * in absolute while every other path is repository-relative, and the
     * abandoned test compares against `git status`, which only ever names
     * repository-relative paths, so an outside file could never match and
     * could only ever make a turn look kept.
     *
     * Surfaced by backfilling a real project, where six of seven records led
     * with files under ~/.claude/projects/.
     */
    // Through symlinks, since git can name the repository /private/var/...
    // where the agent wrote to /var/.... A path read out of a shell command is
    // a guess. One that neither exists now nor was ever committed was never
    // this repository's file.
    const relative = [...new Set([...written]
      .map((p) => [p, toRepo(p)] as const)
      .filter(([p, rel]) => rel !== null && (!guessed.has(p) || existsSync(p) || gitOrNull(repo, ["log", "-1", "--format=%H", "--all", "--", rel])))
      .map(([, rel]) => rel!))];
    // Abandoned when every file this turn wrote is still uncommitted: the work
    // never reached history. A turn that wrote nothing is not abandoned, it is
    // simply a read or shell turn.
    const abandoned = relative.length > 0 && (opts.fresh
      ? relative.every((p) => !dirty.has(p) && !gitOrNull(repo, ["log", "-1", "--format=%H", `--since=${turn[0]!.ts}`, "--", p]))
      : relative.every((p) => dirty.has(p)));

    // Nothing was changed and nothing failed: there is no work here to record,
    // only a turn that happened. Measured on this repository, five of nineteen
    // scraped records were this shape — rows in the log that say nothing.
    // A delegation is evidence too: work happened, it simply happened
    // somewhere this log cannot see. Dropping the turn would lose the only
    // trace of it.
    if (!relative.length && !failures.length && !delegations.length) continue;

    records.push({
      anvc: 0,
      // Derived from the turn, so re-ingesting the same capture events yields
      // the same id and the same ref, and the second write is refused rather
      // than duplicated.
      id: contentUlid([session, turn[0]!.ts, prompt], new Date(turn[0]!.ts).getTime()),
      anchor: head ? { kind: "commit", oid: head } : { kind: "blob", oid: "0".repeat(40) },
      session: { agent: turn[0]!.agent ?? "claude-code", run_id: session },
      // No prompt. The point of this product is that the agent titles its own
      // work, the way it already writes commit messages — a stored prompt is
      // an extraction, and "just continue until u need me" describes nothing a
      // reader can use six months later. What a scraped turn honestly has is
      // its evidence: the files it changed and the commands that failed. The
      // prompt is dropped rather than stored-and-hidden, because a field that
      // exists gets displayed by someone eventually.
      // A delegation's description is a title the parent agent wrote for work
      // it was handing off, which is the same kind of artifact as a goal and
      // not a captured user prompt. It is the only statement of intent a
      // scraped turn can honestly carry.
      intent: delegations.length
        ? { goal: `Delegated: ${delegations.join("; ")}`.slice(0, 200) }
        : {},
      actions: actions.slice(0, 1000),
      delta: relative.length ? { files: relative } : undefined,
      outcome: {
        status: abandoned ? "abandoned" : "kept",
        ...(failures.length ? { errors: failures.slice(0, 20) } : {}),
        // The delegation's goal makes the write rules ask an abandoned record
        // for its check, and no agent is here to name one.
        ...(abandoned && delegations.length ? { recheck: null } : {}),
      },
      // A scraped turn cannot write a narrative — no agent is there to write
      // one — but it can keep what was observed, which is the half that cannot
      // be reconstructed later at any price.
      // At most 24 KiB of it per turn, before the whole-record cap applies.
      ...(outputs.length ? { detail: { output: headTail(outputs.join("\n\n"), 24 * 1024) } } : {}),
      ts: turn.at(-1)!.ts,
      ...(actions.length > 1000 ? { truncated: true } : {}),
    });
  }
  return records;
}

/**
 * Drops detail until the record fits the envelope's 64 KiB cap.
 *
 * A long turn can exceed the cap on actions alone, and adding `outcome.errors`
 * made that reachable for turns that previously fit. Losing the whole record is
 * the worst outcome: a turn's intent and its files are the part worth keeping,
 * and actions are the part that is both bulky and least missed. Shedding in
 * that order keeps the record, and `truncated` records that it happened.
 */
function fit(record: CheckpointRecord): CheckpointRecord {
  const size = (r: CheckpointRecord) => Buffer.byteLength(canonical(r), "utf8");
  if (size(record) <= MAX_RECORD_BYTES) return record;

  const trimmed = { ...record, truncated: true };
  // Output first, because it is the bulkiest thing here and it is trimmed by
  // shape rather than dropped: halving it keeps the head and the tail, which
  // is where a failure announces itself. Actions come next, and the intent and
  // file list are never shed — those are the part that cannot be guessed.
  while (trimmed.detail?.output && size(trimmed) > MAX_RECORD_BYTES) {
    const half = Math.floor(trimmed.detail.output.length / 2);
    if (half < 400) { trimmed.detail = { ...trimmed.detail, output: undefined }; break; }
    trimmed.detail = { ...trimmed.detail, output: headTail(trimmed.detail.output, half) };
  }
  while (trimmed.actions?.length && size(trimmed) > MAX_RECORD_BYTES) {
    trimmed.actions = trimmed.actions.slice(0, Math.floor(trimmed.actions.length / 2));
  }
  if (size(trimmed) > MAX_RECORD_BYTES) trimmed.actions = [];
  return trimmed;
}

/**
 * Writes records for one repo, skipping turns already stored.
 *
 * Capture files are append-only and `anvc ingest` reads the whole directory, so
 * re-running it is the normal workflow, not an edge case. It used to write
 * every turn again on every run — `nextSeq` always advances, so each record
 * landed on a fresh ref and the immutability guard never fired. Three runs over
 * an unchanged directory produced 93 refs for 57 real turns, reported as
 * "(0 already present)".
 *
 * A record's id is now derived from the turn (see `contentUlid`), so identity
 * is checkable before writing: a turn already in the log is skipped, and a
 * turn repeated within one batch is written once.
 *
 * Every record is written private. A scraped record is built from raw session
 * material — every command, its output, every path — and nobody reviewed it.
 * It used to go to the shared tier like everything else, and setup pushes the
 * shared tier: nineteen of this repository's scraped records went to GitHub
 * that way, raw commands and all, while the docs said the raw log stayed on
 * this machine. Sharing one is a decision a person makes, record by record,
 * with `anvc share`.
 */
export function ingest(
  repo: string,
  events: CaptureEvent[],
  opts: { fresh?: boolean } = {},
): { written: number; skipped: number; failed: string[]; ids: string[] } {
  const here = isRepo(repo);
  const forRepo = events.filter((e) => here(e.repo));

  // One pass over the refs rather than one lookup per record.
  const stored = new Set<string>();
  const checkpoints = new Map<string, number[]>();
  for (const [, r] of readRecords(repo)) {
    stored.add(r.id);
    // A scraped record can carry a goal too ("Delegated: ..."), but its time
    // is the end of its own turn, so it only ever covers that turn, which
    // `stored` already skips.
    if (typeof r.intent.goal === "string") {
      (checkpoints.get(r.session.run_id) ?? checkpoints.set(r.session.run_id, []).get(r.session.run_id)!)
        .push(Date.parse(r.ts));
    }
  }
  const records = toRecords(forRepo, repo, checkpoints, { fresh: opts.fresh });

  let written = 0, skipped = 0;
  const failed: string[] = [], ids: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    // Both halves matter: `stored` catches a re-run, `seen` catches the same
    // turn appearing twice inside one capture directory.
    if (stored.has(record.id) || seen.has(record.id)) { skipped++; continue; }
    seen.add(record.id);
    try {
      appendRecord(repo, fit(record), { tier: "private" });
      written++;
      ids.push(record.id);
    } catch (error) {
      // A ref that already exists is still counted as a skip, since a record
      // can be present under a sequence this run did not predict. Anything
      // else is a record being lost, which used to look identical.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Refusing to overwrite")) skipped++;
      else failed.push(`${record.id}: ${message}`);
    }
  }
  return { written, skipped, failed, ids };
}
