/**
 * Runs a person starts themselves: `anvc run -- python train.py --lr 1e-4`.
 *
 * The hooks only see commands an agent runs. Experiments are often started
 * by hand, in a terminal, and those numbers were untraceable. This runs the
 * command as the shell would, passes its output through untouched, and
 * afterwards keeps the same row the capture hook keeps for an agent's
 * command: the command, its output trimmed and scrubbed, whether it
 * succeeded, and the files it wrote and read.
 *
 * The rows go to a log of their own, never into an agent's session: they are
 * not an agent's work, so they don't become records, and a briefing never
 * shows them. Only the lookups that trace a number (whence, the document
 * check) read them.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "./activity";
import { folderOn } from "./folders";
import { readPolicy } from "./policy";
import { captureRoot, jsonl, MAX_OUTPUT, repoKey, trimOutput } from "./rawlog";
import { dataMode } from "./results";
import { runFiles } from "./runs";
import { scrub } from "./scrub";

/** Where the runs in this repository are kept, one file a day. */
const runsDir = (repo: string) => join(captureRoot(), "runs", repoKey(repo));

/** Every file of runs kept for this repository, oldest first. */
export const runsFiles = (repo: string): string[] => jsonl(runsDir(repo));

/** Keeps the start and the end of what a long run prints, without holding all of it. */
class Keep {
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(private readonly cap: number) {}
  add(text: string) {
    if (this.head.length < this.cap) {
      const room = this.cap - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail += text;
    if (this.tail.length > this.cap) {
      this.dropped += this.tail.length - this.cap;
      this.tail = this.tail.slice(-this.cap);
    }
  }
  /**
   * What was kept, scrubbed and trimmed to `cap` as the raw log trims an
   * agent's output. All of it is scrubbed: a scrub capped at half of what this
   * holds cut the tail off any run that printed more than 32 KB. When this
   * dropped a middle, head and tail are trimmed here, so the gap counts those
   * characters too; trimming them together would put trimOutput's count, which
   * can't know about them, in place of this one.
   */
  text(cap: number): string {
    if (!this.dropped) return trimOutput(scrub(this.head + this.tail, this.cap * 2), cap);
    // Collapsed only: no cap is ever reached.
    const clean = (s: string) => trimOutput(scrub(s, this.cap), Infinity);
    const half = Math.floor(cap / 2) - 40;
    const head = clean(this.head), tail = clean(this.tail);
    const gap = this.dropped + Math.max(0, head.length - half) + Math.max(0, tail.length - half);
    return `${head.slice(0, half)}\n\n  [... ${gap} characters not kept ...]\n\n${tail.slice(-half)}`;
  }
}

interface TrackedRun { code: number; logged: boolean; files: string[] }

/**
 * Runs `command` in a shell in `cwd`, printing what it prints, and keeps a
 * row for it when `cwd` is in a repository ANVC is on for. The shell is bash,
 * or cmd.exe on Windows, which usually has no bash; cmd gets the line exactly
 * as it was typed, so it isn't quoted again for it.
 */
export async function trackRun(command: string, cwd = process.cwd()): Promise<TrackedRun> {
  let repo: string | null = null;
  try { repo = repoRoot(cwd); } catch { /* not a repository: just run it */ }
  const keep = new Keep(MAX_OUTPUT * 2);
  const started = new Date().toISOString();
  const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", `"${command}"`] : ["bash", "-c", command];
  const child = Bun.spawn(shell, { cwd, stdin: "inherit", stdout: "pipe", stderr: "pipe", env: process.env, windowsVerbatimArguments: true });
  // Ctrl-C reaches the command; this process stays to keep the row.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const pass = async (stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) => {
    const text = new TextDecoder();
    for await (const chunk of stream) {
      out.write(chunk);
      keep.add(text.decode(chunk, { stream: true }));
    }
  };
  await Promise.all([pass(child.stdout, process.stdout), pass(child.stderr, process.stderr)]);
  const code = await child.exited;
  process.off("SIGINT", ignore);

  if (!repo || !folderOn(repo)) return { code, logged: false, files: [] };
  const { fields } = readPolicy(repo);
  if (fields.commands === "off") return { code, logged: false, files: [] };
  const row: Record<string, unknown> = {
    anvc_capture: 0,
    event: "Run",
    ts: new Date().toISOString(),
    started,
    session_id: null,
    agent: "person",
    cwd,
    repo,
    tool: "Bash",
    command: scrub(command).slice(0, 512),
    ok: code === 0,
    output: fields.output === "off" ? null : keep.text(MAX_OUTPUT),
  };
  let files: string[] = [];
  if (dataMode(repo).mode !== "off") {
    try {
      const found = runFiles(command, cwd, repo);
      if (found.outputs.length) row.outputs = found.outputs;
      if (found.inputs.length) row.inputs = found.inputs;
      files = found.outputs.map((f) => f.path);
    } catch { /* the row is kept without them */ }
  }
  const file = join(runsDir(repo), `${row.ts!.toString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return { code, logged: true, files };
}
