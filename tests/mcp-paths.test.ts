/**
 * An agent started in a subdirectory still records repository paths.
 *
 * Codex registers MCP servers globally, so the server finds the repository from
 * the directory the agent started in. Run from src/, Codex recorded src/math.ts
 * as math.ts, a file that does not exist at the repository root.
 */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listRecords, readRecord } from "../protocol/record";
import { gitRepo } from "./helpers";

const server = resolve(import.meta.dir, "../protocol/mcp.ts");

test("paths from a subdirectory are rebased onto the repository root", async () => {
  const repo = gitRepo();
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src/math.ts"), "");
  await writeFile(join(repo, "README.md"), "");
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "anvc_checkpoint", arguments: {
      goal: "Add subtract", outcome: "kept",
      files: ["math.ts", "src/math.ts", "README.md", join(repo, "src/math.ts"), "/elsewhere/x.ts"] } } },
  ];
  const env = { ...process.env, ANVC_AGENT: "codex" } as Record<string, string | undefined>;
  delete env.ANVC_REPO;
  delete env.CLAUDE_CODE_SESSION_ID;
  const proc = Bun.spawn(["bun", server], {
    cwd: join(repo, "src"), env,
    stdin: Buffer.from(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    stdout: "pipe", stderr: "pipe",
  });
  await proc.exited;

  const refs = listRecords(repo);
  expect(refs).toHaveLength(1);
  const record = readRecord(repo, refs[0]!.ref);
  expect(record.session.agent).toBe("codex");
  expect(record.delta?.files).toEqual(["src/math.ts", "src/math.ts", "README.md", "src/math.ts", "/elsewhere/x.ts"]);
}, 30_000);
