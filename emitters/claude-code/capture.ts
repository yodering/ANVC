#!/usr/bin/env bun
/**
 * ANVC capture hook for Claude Code (emitter, Apache-2.0 scope).
 *
 * Reads one hook payload on stdin and appends one JSONL record per event to
 * $ANVC_CAPTURE_DIR (default ~/.anvc/capture/<repository>/<date>.jsonl), and
 * nothing outside a repository. Never fails the hook: any error is swallowed
 * after a best-effort note to stderr, because a capture fault must not break
 * the user's session.
 *
 * Captures what the Git wire cannot see: the prompt that started a turn, which
 * files were read and written, and which edits were later abandoned. See
 * docs/plan-v1.1.md section 1.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureFile, MAX_OUTPUT, trimOutput as trim } from "../../protocol/rawlog";
import { scrub } from "../../protocol/scrub";
import { repoRoot } from "../../protocol/activity";
import { readPolicy } from "../../protocol/policy";
import { folderOn } from "../../protocol/folders";
import { dataMode } from "../../protocol/results";
import { runFiles } from "../../protocol/runs";
import { codexExit, hookInput, outputOf, succeeded, toolCall } from "../../protocol/agents";
import { keepSources } from "../../protocol/sources";
import { sessionRows } from "../../protocol/evidence";
import { taskGiven } from "../../protocol/status";

const MAX_PROMPT = 8192;

try {
  const hook = await hookInput();
  if (!hook) process.exit(0);
  const { payload, agent, cwd } = hook;
  const event = hook.event ?? "unknown";

  const day = new Date().toISOString().slice(0, 10);

  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  // Each agent's tools, in anvc's terms: Codex's apply_patch is an edit of
  // every file its patch names, exec_command is a shell command.
  const call = toolCall(payload.tool_name, input);
  const tool = call.tool;
  // Claude Code named its delegation tool Task, and now names it Agent.
  const delegation = tool === "Task" || tool === "Agent";
  // Paths are the point: file-read overlap between concurrent sessions cannot
  // be measured from the Git wire, only here.
  const path = call.paths[0] ?? null;
  // Attributed to the repository, the same from every worktree of it: keyed by
  // the worktree's folder, a worktree's history was invisible from the main
  // checkout.
  const repo = repoRoot(cwd);
  // Outside a repository, or in a folder it's turned off for, nothing is
  // captured: the row would hold a prompt and command output that no
  // repository's history asked for, and nothing could turn it off.
  if (!repo || !folderOn(repo)) process.exit(0);
  const text = outputOf(payload);

  const record: Record<string, unknown> = {
    anvc_capture: 0,
    event,
    ts: new Date().toISOString(),
    session_id: payload.session_id ?? null,
    agent,
    transcript: typeof payload.transcript_path === "string" ? payload.transcript_path : null,
    cwd,
    repo,
    tool,
    path: path ? resolve(cwd, String(path)) : null,
    // Records an edit's shape without storing its content.
    bytes: call.bytes,
    command: call.command ? scrub(call.command).slice(0, 512) : null,
    /**
     * What a delegation was for, when the tool was a delegation.
     *
     * Without this a subagent leaves one row saying it existed. Measured on
     * this repository in a day: 902 captured events under a single session id
     * while seven subagents ran and edited files. The work a delegated agent
     * does is work this log is supposed to hold, and the agent's own
     * description of its task is the only account of it we get — the subagent
     * never calls `anvc_checkpoint`, because it does not know we exist.
     *
     * Its `description` is a title the parent wrote, so it is the same kind of
     * artifact as `intent.goal` and not a captured user prompt.
     */
    delegated: delegation && typeof input.description === "string"
      ? scrub(String(input.description)).slice(0, 200) : null,
    agent_type: delegation && typeof input.subagent_type === "string"
      ? String(input.subagent_type).slice(0, 64)
      : typeof payload.agent_type === "string" ? payload.agent_type.slice(0, 64) : null,
    // System-injected text is not the user's intent. A task notification or
    // system reminder recorded as intent.prompt makes `tried` return noise.
    prompt: typeof payload.prompt === "string" && !/^\s*<(task-notification|system-reminder|local-command)/.test(payload.prompt)
      ? scrub(payload.prompt).slice(0, MAX_PROMPT) : null,
    // Cursor sends the result as `tool_output`.
    ok: succeeded(payload, event, agent)
      ?? (agent === "codex" && call.tool === "Bash" ? codexExit(payload.transcript_path, call.command) : null),
    /**
     * What the command actually printed.
     *
     * Scrubbed like everything else, trimmed by shape, and kept because this
     * is the layer a reader falls back to when a record turns out to be wrong.
     * A verdict can only be believed; the output can be re-read.
     *
     * Scrubbed at the output ceiling rather than the prompt one, then trimmed
     * by shape — so what survives is decided by the rules, not by a
     * performance guard borrowed from somewhere else.
     */
    output: text ? trim(scrub(text, MAX_OUTPUT * 2)) : null,
  };

  // A subagent's start and stop, and its own tool calls, carry its id, which
  // is how Status tells which subagents are still running (protocol/status.ts).
  // The start doesn't say what the subagent was asked; its parent's session
  // file does.
  if (typeof payload.agent_id === "string") record.agent_id = payload.agent_id.slice(0, 80);
  if (event === "SubagentStart" && record.transcript && record.session_id) {
    const claimed = new Set(sessionRows(repo, String(record.session_id), null).map((r) => r.tool_use_id).filter((id): id is string => Boolean(id)));
    const task = taskGiven(String(record.transcript), record.agent_type as string | null, claimed);
    if (task) { record.delegated = scrub(task.task).slice(0, 200); record.tool_use_id = task.id; }
  }

  // The project's own choice of what the raw log keeps. A field set to off is
  // never written, rather than written and hidden, because a byte on disk is
  // a byte that can leak.
  const { fields } = readPolicy(repo);
  if (fields.prompts === "off") record.prompt = null;
  if (fields.commands === "off") record.command = null;
  if (fields.output === "off") record.output = null;
  if (fields.paths === "off") record.path = null;
  if (fields.delegations === "off") { record.delegated = null; record.agent_type = null; }
  // The files a command wrote and read, fingerprinted, when the project
  // keeps track of results: what lets a number found in a file lead back to
  // the run that made it (protocol/runs.ts).
  if (tool === "Bash" && call.command && fields.commands !== "off" && dataMode(repo).mode !== "off") {
    try {
      const files = runFiles(call.command, cwd, repo);
      if (files.outputs.length) record.outputs = files.outputs;
      if (files.inputs.length) record.inputs = files.inputs;
    } catch { /* the row is kept without them */ }
  }

  // A patch that touches three files is three edits, one row each.
  const rows = call.paths.length > 1
    ? call.paths.map((p) => ({ ...record, path: record.path === null ? null : resolve(cwd, p) }))
    : [record];
  const file = captureFile(repo, day);
  // This user's only: the log holds prompts and command output (see writeJson).
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  // What the agent read to make a claim: a page, a search, a document (protocol/sources.ts).
  if (event === "PostToolUse" && record.ok !== false && readPolicy(repo).fields.sources !== "off") keepSources(repo, payload, call, cwd, agent);
} catch (error) {
  // Never break the session.
  try { process.stderr.write(`anvc-capture: ${error instanceof Error ? error.name : "error"}\n`); } catch { /* ignore */ }
}
