/**
 * Backfill reads someone's whole session history, so the thing it must never
 * do is invent. These pin that it translates what the transcript said and
 * nothing more — and that a resumed session, which Claude Code writes out as a
 * second file carrying the earlier turns again, does not double every command.
 */
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backfill, transcriptDir } from "../protocol/backfill";
import { gitRepo, tmp } from "./helpers";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
// Codex and Cursor sessions from a folder that doesn't exist, so no test reads this machine's own.
const elsewhere = { codexRoot: "/nonexistent", cursorRoot: "/nonexistent" };

function call(uuid: string, id: string, name: string, input: unknown, ts: string) {
  return line({
    type: "assistant", uuid, timestamp: ts, sessionId: "s1", cwd: "/repo",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}
function result(id: string, content: string, isError = false) {
  return line({
    type: "user", uuid: `r-${id}`, timestamp: "2026-09-01T10:00:01.000Z", sessionId: "s1", cwd: "/repo",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  });
}

async function withTranscripts(files: Record<string, string>) {
  const root = tmp("anvc-backfill-");
  const dir = transcriptDir("/repo", root);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return root;
}

test("a command and its result become one event carrying the outcome", async () => {
  const root = await withTranscripts({
    "a.jsonl":
      call("u1", "t1", "Bash", { command: "bun test" }, "2026-09-01T10:00:00.000Z")
      + result("t1", "3 pass 0 fail"),
  });
  const r = backfill("/repo", { ...elsewhere, root });
  expect(r.events).toHaveLength(1);
  const [event] = r.events;
  expect(event!.tool).toBe("Bash");
  expect(event!.command).toBe("bun test");
  // The outcome is the half that matters, and it lives on a different line.
  expect(event!.ok).toBe(true);
  expect(event!.output).toBe("3 pass 0 fail");
});

test("a failed command is recorded as failed", async () => {
  const root = await withTranscripts({
    "a.jsonl":
      call("u1", "t1", "Bash", { command: "bun test" }, "2026-09-01T10:00:00.000Z")
      + result("t1", "1 fail", true),
  });
  const [event] = backfill("/repo", { ...elsewhere, root }).events;
  expect(event!.ok).toBe(false);
});

test("a session that reached the repository through a symlink is its history", async () => {
  // As on macOS, where git says /private/var/... and the session says /var/....
  const repo = gitRepo();
  const link = join(tmp("anvc-link-"), "repo");
  symlinkSync(repo, link);
  const root = tmp("anvc-backfill-");
  const dir = transcriptDir(repo, root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.jsonl"), call("u1", "t1", "Bash", { command: "bun test" }, "2026-09-01T10:00:00.000Z").replace('"cwd":"/repo"', `"cwd":${JSON.stringify(link)}`));
  const { events } = backfill(repo, { ...elsewhere, root });
  expect(events.map((e) => e.repo)).toEqual([repo]);
});

test("long output keeps its end, where the failure is printed", async () => {
  const printed = `${Array.from({ length: 5000 }, (_, i) => `step ${i} ok`).join("\n")}\n1 fail: pool closed`;
  const root = await withTranscripts({
    "a.jsonl": call("u1", "t1", "Bash", { command: "bun test" }, "2026-09-01T10:00:00.000Z") + result("t1", printed, true),
  });
  const [event] = backfill("/repo", { ...elsewhere, root }).events;
  expect(event!.output).toStartWith("step 0 ok");
  expect(event!.output).toEndWith("1 fail: pool closed");
  expect(event!.output).toContain("characters not kept");
});

test("a secret in an imported session is redacted when no scrub is passed", async () => {
  const secret = ["ghp", "FAKEfake0000FAKEfake0000"].join("_");
  const root = await withTranscripts({
    "a.jsonl":
      call("u1", "t1", "Bash", { command: `GITHUB_TOKEN=${secret} gh pr list` }, "2026-09-01T10:00:00.000Z")
      + result("t1", `authenticated with ${secret}`, true),
  });
  const [event] = backfill("/repo", { ...elsewhere, root }).events;
  expect(JSON.stringify(event)).not.toContain(secret);
});

test("a resumed session does not double its earlier turns", async () => {
  // Claude Code copies earlier turns into the new file verbatim. Measured on
  // this repository before the fix: 350 of 2,597 commands appeared twice.
  const first = call("u1", "t1", "Bash", { command: "echo one" }, "2026-09-01T10:00:00.000Z");
  const root = await withTranscripts({
    "a.jsonl": first,
    "b.jsonl": first + call("u2", "t2", "Bash", { command: "echo two" }, "2026-09-01T11:00:00.000Z"),
  });
  const r = backfill("/repo", { ...elsewhere, root });
  expect(r.events.map((e) => e.command)).toEqual(["echo one", "echo two"]);
});

test("a person's prompt is kept and the harness's own notices are not", async () => {
  const root = await withTranscripts({
    "a.jsonl":
      line({ type: "user", uuid: "p1", timestamp: "2026-09-01T10:00:00.000Z", sessionId: "s1", cwd: "/repo",
        message: { content: "fix the failing test" } })
      + line({ type: "user", uuid: "p2", timestamp: "2026-09-01T10:01:00.000Z", sessionId: "s1", cwd: "/repo",
        message: { content: "<system-reminder>something</system-reminder>" } }),
  });
  const r = backfill("/repo", { ...elsewhere, root });
  expect(r.events).toHaveLength(1);
  expect(r.events[0]!.prompt).toBe("fix the failing test");
});

test("a delegation keeps the brief the parent wrote", async () => {
  // Claude Code called the tool Task, and now calls it Agent.
  for (const tool of ["Task", "Agent"]) {
    const root = await withTranscripts({
      "a.jsonl": call("u1", "t1", tool,
        { description: "Research graph layouts", subagent_type: "general-purpose" },
        "2026-09-01T10:00:00.000Z"),
    });
    const [event] = backfill("/repo", { ...elsewhere, root }).events;
    // Without this a subagent leaves one row saying only that it existed.
    expect(event!.delegated).toBe("Research graph layouts");
    expect(event!.agent_type).toBe("general-purpose");
  }
});

test("a repository with no transcripts reads as empty rather than failing", async () => {
  const root = await withTranscripts({});
  const r = backfill("/nowhere", { ...elsewhere, root });
  expect(r.events).toEqual([]);
  expect(r.files).toBe(0);
});

test("since leaves out everything before it", async () => {
  const root = await withTranscripts({
    "a.jsonl":
      call("u1", "t1", "Bash", { command: "old" }, "2026-09-01T10:00:00.000Z")
      + call("u2", "t2", "Bash", { command: "new" }, "2026-09-05T10:00:00.000Z"),
  });
  const r = backfill("/repo", { ...elsewhere, root, since: "2026-09-03T00:00:00.000Z" });
  expect(r.events.map((e) => e.command)).toEqual(["new"]);
});

test("a repository name with underscores finds its transcripts", async () => {
  // Claude Code replaces underscores with dashes as well as separators. Missing
  // that reads as "no history" rather than as a path that did not match, which
  // is the worst way for this to fail.
  expect(transcriptDir("/home/u/Gits/my_app_name", "/root"))
    .toBe(join("/root", "-home-u-Gits-my-app-name"));
  // And on Windows, the drive's colon and the backslashes.
  expect(transcriptDir("C:\\Users\\u\\my_app", "/root")).toBe(join("/root", "C--Users-u-my-app"));
});

test("every event names the repository, or ingest drops it silently", async () => {
  const root = await withTranscripts({
    "a.jsonl": call("u1", "t1", "Bash", { command: "bun test" }, "2026-09-01T10:00:00.000Z"),
  });
  const [event] = backfill("/repo", { ...elsewhere, root }).events;
  // `ingest` filters on `repo`. Leaving it null wrote zero records from
  // eleven real events, and said nothing about why.
  expect(event!.repo).toBe("/repo");
});
