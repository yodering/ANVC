/**
 * The agent has to be handed dead ends without asking — and handed nothing the
 * rest of the time.
 *
 * Retrieval that waits to be asked mostly does not fire: measured on this
 * repository, the one abandoned attempt is found by the exact word
 * "summarizer" and by nothing else. But unconditional injection is the wrong
 * fix — it costs +20-23% inference for no significant success gain, and a
 * single irrelevant item measurably degrades retrieval. A stale "we tried X"
 * is the worst shape: topically on point, operationally wrong.
 *
 * So silence is the contract, and these tests are mostly about silence.
 *
 * What these tests cannot tell you: whether anything reads what the hook
 * writes. Every assertion here checks the JSON on stdout, and for months the
 * `PreToolUse` branch emitted perfect JSON that Claude Code discarded — the
 * documentation lists the field as supported and shows no example of it, which
 * was the only hint. A green suite meant the hook was correct, not that the
 * agent heard it. Delivery is verified by asking a live agent and reading its
 * reply; the events confirmed that way are `SessionStart` and
 * `UserPromptSubmit`. Do not add a branch on a new event without doing that.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendDaily } from "../protocol/activity";
import { writeAssist } from "../protocol/assist";
import { appendRecord, type CheckpointRecord } from "../protocol/record";
import { recordResult, setDataMode } from "../protocol/results";
import { addGoal } from "../protocol/goals";
import { addRule } from "../protocol/rules";
import { addItem } from "../protocol/status";
import { writeNote } from "../protocol/tools";
import { git, gitRepo, rec, tmp, writeCapture } from "./helpers";

const INJECT = resolve(import.meta.dir, "../emitters/claude-code/inject.ts");

/** Runs the hook the way Claude Code does, and returns what it injected. */
function inject(event: string, payload: Record<string, unknown>, stateDir: string, metricsDir?: string) {
  const proc = Bun.spawnSync(["bun", INJECT, event], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: event, ...payload })),
    env: {
      ...process.env,
      ANVC_STATE_DIR: stateDir,
      // Default to the state dir so a test never writes into the real
      // ~/.anvc/metrics and pollutes a measurement with fixture rows.
      ANVC_METRICS_DIR: metricsDir ?? join(stateDir, "metrics"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const out = proc.stdout.toString().trim();
  return {
    exitCode: proc.exitCode,
    context: out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : null,
  };
}

const abandoned = (goal: string, why: string, files: string[]) => rec({
  intent: { goal }, outcome: { status: "abandoned", errors: [why], recheck: "bun test" },
  ...(files.length ? { delta: { files } } : {}),
});

function fixture() {
  return { repo: gitRepo({ commit: true }), state: tmp("anvc-inject-state-") };
}

test("opening a file with a dead end is told about it, unasked", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned(
    "Cache the ref index in memory",
    "goes stale after any write, and nothing invalidates it",
    ["server/api.ts"],
  ));

  const { context } = inject("PreToolUse", {
    session_id: "s1", cwd: repo,
    tool_input: { file_path: join(repo, "server/api.ts") },
  }, state);

  expect(context).toContain("server/api.ts");
  expect(context).toContain("Cache the ref index in memory");
  // The reason is the half that changes a decision; without it the agent
  // only knows to avoid something, not why.
  expect(context).toContain("goes stale after any write");
}, 60_000);

test("a file with nothing abandoned gets nothing", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "stale", ["server/api.ts"]));
  // A different file. Saying something irrelevant here is the documented
  // failure mode, so the correct output is nothing at all.
  const { context } = inject("PreToolUse", {
    session_id: "s1", cwd: repo,
    tool_input: { file_path: join(repo, "protocol/query.ts") },
  }, state);
  expect(context).toBeNull();
}, 60_000);

test("the same path is spoken about once per session", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "stale", ["server/api.ts"]));
  const payload = {
    session_id: "s1", cwd: repo,
    tool_input: { file_path: join(repo, "server/api.ts") },
  };

  expect(inject("PreToolUse", payload, state).context).toContain("Cache the ref index");
  // A file read twenty times must not inject twenty times; repetition is
  // what makes injected context read as noise.
  expect(inject("PreToolUse", payload, state).context).toBeNull();

  // A different session starts fresh.
  expect(inject("PreToolUse", { ...payload, session_id: "s2" }, state).context)
    .toContain("Cache the ref index");
}, 60_000);

test("a file with nothing abandoned is asked again once something is", async () => {
  const { repo, state } = fixture();
  const payload = {
    session_id: "s1", cwd: repo,
    tool_input: { file_path: join(repo, "server/api.ts") },
  };

  // Opened before anything was recorded about it: nothing to say.
  expect(inject("PreToolUse", payload, state).context).toBeNull();

  // Then the agent works, abandons the approach, and records it — the
  // ordinary sequence.
  appendRecord(repo, abandoned(
    "Cache the ref index in memory",
    "goes stale after any write",
    ["server/api.ts"],
  ));

  // Coming back to the same file must now say so. Claiming the path on the
  // earlier miss silenced this permanently, which meant the hook went quiet
  // on exactly the files being actively worked on.
  expect(inject("PreToolUse", payload, state).context).toContain("Cache the ref index in memory");
}, 60_000);

test("a record too long to fit on its own doesn't hide the ones after it", async () => {
  const { repo, state } = fixture();
  // Checks off, so the long check command is shown rather than run.
  writeAssist(repo, { moment: "checks", on: false });
  const path = `src/${"a".repeat(150)}.ts`;
  const payload = { session_id: "s1", cwd: repo, tool_input: { file_path: join(repo, path) } };
  appendRecord(repo, {
    ...abandoned("g".repeat(200), "e".repeat(500), [path]),
    outcome: { status: "abandoned", errors: ["e".repeat(500)], recheck: `python3 -m unittest ${"t".repeat(80)} ${"u".repeat(80)} ${"v".repeat(80)}` },
    detail: { narrative: "what was ruled out" },
  } as CheckpointRecord);
  // Alone, it's longer than a block may be.
  expect(inject("PreToolUse", payload, state).context).toBeNull();

  appendRecord(repo, { ...abandoned("Cache the ref index", "stale", [path]), ts: new Date(Date.now() - 3_600_000).toISOString() });
  const { context } = inject("PreToolUse", payload, state);
  expect(context).toContain("Cache the ref index");
  expect(context).not.toContain("ggg");
}, 60_000);

test("a prompt about a dead end is answered with it", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned(
    "Try a separate summarizer model for intent",
    "it can only re-read the transcript, so it has strictly less information",
    [],
  ));

  // UserPromptSubmit is the event that actually reaches the model.
  // PreToolUse knows the exact file and is discarded, so this is where the
  // per-file case had to move to.
  const { context } = inject("UserPromptSubmit", {
    session_id: "s1", cwd: repo,
    prompt: "should we use a separate summarizer model to write the intent?",
  }, state);

  expect(context).toContain("Try a separate summarizer model");
  expect(context).toContain("strictly less information");
}, 60_000);

test("an unrelated prompt is answered with silence", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Try a separate summarizer model for intent", "less information", []));

  // This is the whole risk of matching on words instead of paths: a loose
  // `OR` over the same terms returns a quarter of this repository's records.
  // A stale dead end dragged into an unrelated turn is the worst shape of
  // context there is — topically plausible, operationally wrong.
  for (const prompt of [
    "add a dark mode toggle to the settings page",
    "what is the weather in Berlin today",
    "ok go for it",           // nothing substantive to search on
    "thanks!",
  ]) {
    expect(inject("UserPromptSubmit", { session_id: `s-${prompt}`, cwd: repo, prompt }, state).context,
      `expected silence for: ${prompt}`).toBeNull();
  }
}, 60_000);

test("the same records are not repeated to the same session", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Try a separate summarizer model for intent", "less information", []));
  const ask = (prompt: string) => inject("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt }, state).context;

  expect(ask("what about a summarizer model for intent?")).toContain("summarizer");
  // Asked again in different words. The dedupe is on what would be said, not
  // on the prompt, so rewording the question does not re-inject the answer.
  expect(ask("could a separate summarizer write the intent instead?")).toBeNull();
}, 60_000);

test("a record said at session start is not said again by the prompt or the file", async () => {
  const { repo, state } = fixture();
  // The yodermon trial's shape: one dead end, reached by all three events
  // before the agent's first turn, each of which injected it.
  appendRecord(repo, abandoned(
    "Import trading_bot into the MCP server for its calendar",
    "pulls in the Database helper",
    ["mcp_server/yodermon_readonly.py"],
  ));
  const payload = { session_id: "s1", cwd: repo };

  expect(inject("SessionStart", { ...payload, source: "startup" }, state).context).toContain("Import trading_bot");
  expect(inject("UserPromptSubmit", {
    ...payload, prompt: "reuse the calendar logic in trading_bot for the MCP server",
  }, state).context).toBeNull();
  expect(inject("PreToolUse", {
    ...payload, tool_input: { file_path: join(repo, "mcp_server/yodermon_readonly.py") },
  }, state).context).toBeNull();
}, 60_000);

test("a record already said does not hide one that was not", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index in memory", "goes stale after any write", []));
  const payload = { session_id: "s1", cwd: repo };
  expect(inject("SessionStart", { ...payload, source: "startup" }, state).context).toContain("Cache the ref index in memory");

  appendRecord(repo, abandoned("Cache the ref index on disk", "two writers corrupt it", []));
  const { context } = inject("UserPromptSubmit", { ...payload, prompt: "how should the ref index be cached?" }, state);
  expect(context).toContain("Cache the ref index on disk");
  expect(context).not.toContain("in memory");
}, 60_000);

test("after compaction a record can be said once more, and only once", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "goes stale after any write", ["server/api.ts"]));
  const payload = { session_id: "s1", cwd: repo };
  const read = () => inject("PreToolUse", { ...payload, tool_input: { file_path: join(repo, "server/api.ts") } }, state).context;

  expect(inject("SessionStart", { ...payload, source: "startup" }, state).context).toContain("Cache the ref index");
  expect(read()).toBeNull();

  // Compaction took what was said with it.
  expect(inject("SessionStart", { ...payload, source: "compact" }, state).context).toContain("Cache the ref index");
  expect(read()).toBeNull();
}, 60_000);

test("kept and abandoned work are not presented as the same thing", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index in memory", "goes stale after any write", []));
  appendRecord(repo, rec({
    intent: { goal: "Rebuild the ref index from refs on every read" },
    outcome: { status: "kept", tests: { passed: 10, failed: 0 } },
  }));

  const { context } = inject("UserPromptSubmit", {
    session_id: "s1", cwd: repo, prompt: "how should the ref index be cached or rebuilt?",
  }, state);

  // "We tried this and dropped it" and "this is how it is done here" are
  // opposite instructions; one header cannot carry both.
  expect(context).toContain("abandoned");
  expect(context).toContain("stands");
}, 60_000);

test("system-injected text is not treated as the user asking", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Try a separate summarizer model for intent", "less information", []));
  // A task notification mentioning the same words is not a question.
  expect(inject("UserPromptSubmit", {
    session_id: "s1", cwd: repo,
    prompt: "<task-notification>summarizer model intent finished</task-notification>",
  }, state).context).toBeNull();
}, 60_000);

test("session start offers recent dead ends, once", async () => {
  const { repo, state } = fixture();
  // No files on this record: a dead end with no file would never surface
  // through the per-path gate, which is why session start exists.
  appendRecord(repo, abandoned("Try a separate summarizer model", "less information than the agent", []));

  const first = inject("SessionStart", { session_id: "s1", cwd: repo }, state);
  expect(first.context).toContain("Try a separate summarizer model");
  expect(first.context?.toLowerCase()).toContain("dead end");

  expect(inject("SessionStart", { session_id: "s1", cwd: repo }, state).context).toBeNull();
}, 60_000);

test("compaction re-briefs the agent, in the same session", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "goes stale after any write", ["server/api.ts"]));
  const at = (source: string) => inject("SessionStart", { session_id: "s1", cwd: repo, source }, state);

  expect(at("startup").context).toContain("Cache the ref index");
  // Same session, already briefed: silence is right.
  expect(at("startup").context).toBeNull();

  // But compaction has taken the agent's tool outputs and reasoning with it,
  // so the session id being unchanged means nothing. This is the moment it
  // is most likely to walk back into a dead end it already walked, and we
  // used to say nothing precisely then.
  expect(at("compact").context).toContain("Cache the ref index");
  expect(at("clear").context).toContain("Cache the ref index");
  expect(at("resume").context).toContain("Cache the ref index");
  // `fork` is the fifth documented matcher and the one we had not heard of.
  expect(at("fork").context).toContain("Cache the ref index");
}, 60_000);

test("session start says what worked, not only what failed", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "goes stale", ["server/api.ts"]));
  // On a real log most records are kept — only one in twenty-one of ours is
  // abandoned — so a briefing of dead ends alone has almost nothing to say.
  appendRecord(repo, rec({
    intent: { goal: "Read every record in one git process" },
    outcome: { status: "kept", tests: { passed: 10, failed: 0 } },
    delta: { files: ["protocol/record.ts"] },
  }));

  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state);
  expect(context).toContain("Cache the ref index");
  expect(context).toContain("Read every record in one git process");
}, 60_000);

test("an empty log says only that ANVC is on", async () => {
  const { repo, state } = fixture();
  expect(inject("SessionStart", { session_id: "s1", cwd: repo }, state).context)
    .toBe("anvc is on in this repository, and it has no records yet. When you finish or stop an attempt, record it with the anvc_checkpoint tool.");
}, 60_000);

test("it never breaks the session", async () => {
  const { repo, state } = fixture();
  // Outside the repository, not a repository at all, and malformed input.
  // Each must exit 0 and inject nothing: a hook that fails takes the tool
  // call down with it.
  expect(inject("PreToolUse", {
    session_id: "s1", cwd: repo, tool_input: { file_path: "/etc/hosts" },
  }, state)).toEqual({ exitCode: 0, context: null });

  expect(inject("SessionStart", { session_id: "s1", cwd: "/" }, state))
    .toEqual({ exitCode: 0, context: null });

  const broken = Bun.spawnSync(["bun", INJECT, "SessionStart"], {
    stdin: new TextEncoder().encode("not json at all"),
    env: { ...process.env, ANVC_STATE_DIR: state },
    stdout: "pipe", stderr: "pipe",
  });
  expect(broken.exitCode).toBe(0);
  expect(broken.stdout.toString().trim()).toBe("");
}, 60_000);

test("the block stays small enough to survive the hook limit", async () => {
  const { repo, state } = fixture();
  // Ten dead ends with long reasons. Claude Code replaces a hook's whole
  // output with a stub past 10,000 characters, silently, while still
  // reporting success — so the budget has to hold under pressure.
  for (let i = 0; i < 10; i++) {
    appendRecord(repo, abandoned(
      `Approach number ${i} with a deliberately long goal line to push the budget`,
      "a long explanation of why this failed, repeated at length ".repeat(6),
      [],
    ));
  }
  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo }, state);
  expect(context).toBeTruthy();
  expect(context!.length).toBeLessThan(2_000);
  // Whole items are dropped rather than cut in half: a truncated reason is
  // worse than an omitted one, because the reader cannot tell what is gone.
  // Counted as items, since the session reminder and the credit line sit
  // around the block and are not part of what the budget drops.
  expect(context!.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(3);
}, 60_000);

test("a dead end hands over the command that would falsify it", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, {
    ...abandoned("Cache the ref index in memory", "goes stale after any write", ["server/api.ts"]),
    outcome: { status: "abandoned", errors: ["goes stale after any write"], recheck: "bun test tests/cache.test.ts" },
  } as CheckpointRecord);

  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state);

  // Without this the block is a verdict the reader can only obey. If the
  // original diagnosis was wrong — the classic case being a failure caused
  // by a broken fixture rather than the approach — the record misleads every
  // session after it and nothing in the block offers a way to find out.
  //
  // At session start the hook now runs the check itself rather than handing
  // the command over, because a pointer the reader must follow measured
  // worse than no record at all. So the assertion is on the observation.
  expect(context).toContain("checked just now");
}, 60_000);

test("a subagent is briefed, because it inherits nothing from its parent", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned(
    "Try a separate summarizer model for intent",
    "it can only re-read the transcript, so it has strictly less information",
    [],
  ));

  // A subagent starts with a fresh, isolated context window: no parent
  // conversation, no parent tool results, and nothing this hook injected
  // into the parent. Measured here in one day — 902 captured events under a
  // single session id while seven subagents ran and edited files. The agent
  // doing the actual editing was the one getting nothing.
  const { context } = inject("SubagentStart", {
    session_id: "s1", cwd: repo, agent_id: "agent-abc", agent_type: "general-purpose",
  }, state);

  expect(context).toContain("Try a separate summarizer model");
  expect(context).toContain("strictly less information");
}, 60_000);

test("each subagent is briefed, not just the first", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "goes stale after any write", []));
  const brief = (agentId: string) =>
    inject("SubagentStart", { session_id: "s1", cwd: repo, agent_id: agentId }, state).context;

  // Subagents share their parent's session id, so keying the once-per-session
  // guard on that alone would brief the first one and silence every one
  // after it. `agent_id` is present only inside a subagent.
  expect(brief("agent-1")).toContain("Cache the ref index");
  expect(brief("agent-2")).toContain("Cache the ref index");
  expect(brief("agent-3")).toContain("Cache the ref index");
}, 60_000);

// Skipped where make isn't installed, as on many Windows machines: the check is make test.
test.skipIf(!Bun.which("make"))("a dead end is resolved by running its check, not by asking the reader to", async () => {
  const { repo, state } = fixture();
  // A record carrying a pointer to fuller evidence did worse than no record
  // at all, because nothing followed the pointer. So the dense half is resolved rather than offered: the hook runs
  // the command and hands over what happened.
  appendRecord(repo, {
    ...abandoned("Cache the ref index in memory", "goes stale after any write", []),
    outcome: { status: "abandoned", errors: ["goes stale after any write"], recheck: "make test" },
  } as CheckpointRecord);

  // A Makefile whose test target fails, so the check has a real answer.
  await Bun.write(join(repo, "Makefile"), "test:\n\t@exit 1\n");

  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state);
  expect(context).toContain("Cache the ref index in memory");
  // An observation, not homework.
  expect(context).toContain("checked just now: still fails, so this still holds");
  expect(context).not.toContain("still true?");
}, 60_000);

test("a record cannot make the hook run anything it likes", async () => {
  const { repo, state } = fixture();
  // Records travel through `git push`, so a record from a teammate's clone or
  // a pull request is untrusted input that the hook would otherwise hand to a
  // shell. The guard is an allowlist of whole commands, not a denylist of
  // dangerous-looking characters.
  const marker = join(repo, "ran");
  for (const recheck of [
    `touch ${marker}`,
    `bun test x; touch ${marker}`,
    `bun test x && touch ${marker}`,
    `bun test $(touch ${marker})`,
    // A newline or tab once passed the allowlist, and sh ran what followed.
    `bun test\ntouch ${marker}`,
    `bun test\ttouch\n${marker}`,
    `curl http://example.com`,
    `rm -rf /`,
  ]) {
    const fresh = tmp("anvc-inj-state-");
    appendRecord(repo, {
      ...abandoned(`Try ${recheck.slice(0, 20)}`, "failed", []),
      outcome: { status: "abandoned", errors: ["failed"], recheck },
    } as CheckpointRecord);
    const { context } = inject("SessionStart", { session_id: `s-${Math.random()}`, cwd: repo, source: "startup" }, fresh);
    // It may be mentioned; it must never have been run.
    expect(context ?? "").not.toContain("checked just now");
    expect(existsSync(marker), `a record ran: ${recheck}`).toBe(false);
  }
}, 90_000);

test("a record fetched from a remote never has its check run", async () => {
  const { repo, state } = fixture();
  await Bun.write(join(repo, "Makefile"), "test:\n\t@exit 1\n");
  const { ref } = appendRecord(repo, {
    ...abandoned("Cache the ref index in memory", "goes stale after any write", []),
    outcome: { status: "abandoned", errors: ["goes stale after any write"], recheck: "make test" },
  } as CheckpointRecord);
  // Where git fetch puts a teammate's records: their choice of command, run here, would be their code.
  const oid = git(repo, "rev-parse", ref).trim();
  git(repo, "update-ref", ref.replace(/^refs\/anvc\//, "refs/remotes/origin/anvc/"), oid);
  git(repo, "update-ref", "-d", ref);
  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state);
  expect(context).toContain("Cache the ref index in memory");
  expect(context).not.toContain("checked just now");
}, 60_000);

test("every invocation is recorded, misses included", async () => {
  const { repo, state } = fixture();
  const metrics = tmp("anvc-metrics-");
  appendRecord(repo, abandoned("Cache the ref index in memory", "goes stale after any write", []));

  // A hit, then a miss, then the subagent event that used to leave no trace.
  inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state, metrics);
  inject("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt: "add a dark mode toggle" }, state, metrics);
  inject("SubagentStart", { session_id: "s1", cwd: repo, agent_id: "agent-7" }, state, metrics);

  const day = new Date().toISOString().slice(0, 10);
  const rows = (await Bun.file(join(metrics, `${day}.jsonl`)).text())
    .trim().split("\n").map((l) => JSON.parse(l));
  expect(rows).toHaveLength(3);

  const [start, prompt, sub] = rows;
  // Which records an agent actually saw. A hash of the rendered text cannot
  // answer "was record X ever shown", and that is the question every later
  // metric depends on.
  expect(start.injected).toBe(true);
  expect(start.records).toHaveLength(1);

  // The miss is the point. Without rows for the times the hook ran and said
  // nothing there is no denominator, so "injection helped" has no rate — only
  // anecdotes, which is exactly the state of the field.
  expect(prompt.injected).toBe(false);
  expect(prompt.records).toEqual([]);
  expect(prompt.chars).toBe(0);

  // The subagent is the agent that does the editing, and it wrote nothing
  // anywhere before this.
  expect(sub.event).toBe("SubagentStart");
  expect(sub.agent_id).toBe("agent-7");
}, 60_000);

test("everything said at once stays under Claude Code's limit, and the metrics say what was", async () => {
  const { repo, state } = fixture();
  const metrics = tmp("anvc-metrics-");
  const person = { kind: "person" as const };
  const long = (what: string, i: number) => `${what} ${i} ${"with a title long enough to fill its share of the block ".repeat(3)}`.slice(0, 190);
  const reason = "a reason that goes on ".repeat(6);
  // Every block a session start can say, each near its own cap.
  for (let i = 0; i < 6; i++) {
    const session = { agent: "claude-code", run_id: i < 4 ? "s1" : "s0" };
    appendRecord(repo, rec({ session, intent: { goal: long("Dead end", i) }, outcome: { status: "abandoned", errors: [reason], recheck: null } }));
    appendRecord(repo, rec({ session, intent: { goal: long("Kept", i) }, outcome: { status: "kept", errors: [reason.repeat(2)], tests: { passed: 10, failed: 0 } } }));
  }
  for (let i = 0; i < 15; i++) {
    addItem(repo, { title: long("Item", i) }, person);
    addGoal(repo, { title: long("Goal", i) }, person);
    writeNote(repo, `tool${i}`, long("Use it", i), person);
    addRule(repo, { name: `Rules ${i}`, applies: [`docs/${"x".repeat(60)}${i}/**/*.md`], text: "Write plainly." }, person);
  }
  // What this session did before compaction, and what the one before it left.
  const path = (i: number) => join(repo, `src/${"p".repeat(60)}${i}.ts`);
  writeCapture(repo, ["s1", "s0"].flatMap((session_id) => [
    ...[0, 1, 2].map((i) => ({ session_id, tool: "Bash", ok: false, command: `bun test ${"t".repeat(70)}${i}`, output: `Error: ${"it broke ".repeat(12)}${i}` })),
    ...[0, 1, 2, 3, 4, 5].map((i) => ({ session_id, tool: "Edit", path: path(i) })),
  ]));
  for (let i = 0; i < 3; i++) {
    recordResult(repo, { name: long("Result", i).slice(0, 120), value: `0.9${i}`, status: "locked" }, { kind: "agent", agent: "claude-code", session: "s9" });
  }
  // And what happened in the days since an agent was last here.
  appendDaily(process.env.ANVC_ACTIVITY_DIR!, { ts: new Date(Date.now() - 5 * 86_400_000).toISOString(), kind: "injected", repo, session: "old" });

  // Measured before the total was capped: 10,702 characters, and Claude Code
  // replaces a block past 10,000 with a stub.
  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "compact" }, state, metrics);
  expect(context!.length).toBeLessThanOrEqual(9_000);
  expect(context).toContain("this session before compaction");
  // The last blocks are left out whole, and not claimed, so they're said another time.
  expect(context).not.toContain("tool0");
  expect(context).not.toContain("Rules 0");
  const claimed = readFileSync(join(state, "s1.txt"), "utf8").split("\n");
  expect(claimed).toContain("@status");
  expect(claimed).not.toContain("@tools");
  expect(claimed).not.toContain("@rules");

  // The metrics row counts what was said.
  const day = new Date().toISOString().slice(0, 10);
  const [row] = (await Bun.file(join(metrics, `${day}.jsonl`)).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(row.chars).toBe(context!.length);
  expect(row.records).toHaveLength(context!.split("\n").filter((l) => /^- ("Dead end|"Kept|Result )/.test(l)).length);
}, 60_000);

// Skipped on Windows: the stand-in for git is a sh script.
test.skipIf(process.platform === "win32")("a session start reads the records into its index once", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index in memory", "goes stale after any write", []));
  // These read the records themselves, without the index.
  for (const moment of ["rules", "tools", "autosave"] as const) writeAssist(repo, { moment, on: false });
  setDataMode(repo, "off");
  // git, logging each call: the index is built from `git cat-file --batch`
  // over every record.
  const bin = tmp("anvc-git-shim-");
  const log = join(bin, "calls");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${Bun.which("git")}" "$@"\n`, { mode: 0o755 });
  const proc = Bun.spawnSync(["bun", INJECT, "SessionStart"], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: repo, source: "startup" })),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANVC_STATE_DIR: state, ANVC_METRICS_DIR: join(state, "metrics") },
    stdout: "pipe", stderr: "pipe",
  });
  expect(proc.stdout.toString()).toContain("Cache the ref index in memory");
  // The briefing, the reminder, the handoff, Status and the goals each built
  // their own.
  expect(readFileSync(log, "utf8").split("\n").filter((l) => l.endsWith("cat-file --batch"))).toHaveLength(1);
}, 60_000);

test("a broken metrics directory cannot break a session", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, abandoned("Cache the ref index", "goes stale", []));
  // A path that cannot be created, on any system: under a file. Measurement
  // is not worth a failed hook, so the injection must still be produced and
  // the exit code must be clean.
  const file = join(state, "a-file");
  writeFileSync(file, "");
  const { exitCode, context } = inject(
    "SessionStart", { session_id: "s1", cwd: repo, source: "startup" },
    state, join(file, "metrics"),
  );
  expect(exitCode).toBe(0);
  expect(context).toContain("Cache the ref index");
}, 60_000);

test("a record with a dense half says so, and still fits the budget", async () => {
  const { repo, state } = fixture();
  const dense = {
    ...abandoned("Cache one default SSLContext at module scope", "concurrency issues", []),
    detail: {
      output: "x".repeat(4_000),
      narrative: "y".repeat(4_000),
      not_investigated: ["whether a context pool sized to the worker count works"],
    },
  } as CheckpointRecord;
  appendRecord(repo, dense);

  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state);

  // None of the eight thousand characters reaches the block. The two budgets
  // are separate: a git blob is cheap and context is not.
  expect(context).not.toContain("xxxx");
  expect(context).not.toContain("yyyy");
  expect(context!.length).toBeLessThan(1_400);

  // But a reader that cannot tell the detail exists will never ask for it,
  // so the line names the tool and the id — concrete, not a vague hint that
  // "more is available", which measured worse than no record at all.
  expect(context).toContain("anvc_detail");
  expect(context).toContain(dense.id);
}, 60_000);

// Skipped where make isn't installed, as on many Windows machines: the check is make test.
test.skipIf(!Bun.which("make"))("a check that passes now says the record may no longer be true, in words", async () => {
  const { repo, state } = fixture();
  appendRecord(repo, {
    ...abandoned("Cache the ref index in memory", "goes stale after any write", []),
    outcome: { status: "abandoned", errors: ["goes stale after any write"], recheck: "make test" },
  } as CheckpointRecord);
  // The check that failed then passes now: the record may be stale.
  await Bun.write(join(repo, "Makefile"), "test:\n\t@exit 0\n");
  const { context } = inject("SessionStart", { session_id: "s1", cwd: repo, source: "startup" }, state);
  // "checked just now: passes" left agents following the stale record;
  // saying what passing means didn't.
  expect(context).toContain("passes now, so this may no longer be true; read the current code before following it");
}, 60_000);
