/**
 * What anvc holds for a repository, split by who can see it.
 *
 * Two tiers, and the difference between them is the one thing a user has to
 * understand before trusting this with real work:
 *
 *   private — on this machine only. The raw capture log, the Claude Code
 *             transcripts backfill reads, the injection metrics, and any record
 *             under refs/anvc-private/. Nothing here is ever pushed.
 *   shared  — records under refs/anvc/. They travel with `git push`, so a
 *             teammate's fetch brings them in and their agents read them.
 *
 * The private tier is by far the larger — every command and everything it
 * printed — and that is by design: keep everything, share what was decided.
 *
 * One function computes the facts so the CLI and the page cannot disagree
 * about them.
 */
import { readFileSync } from "node:fs";
import { captureFiles, isRepo, jsonl, metricsRoot, samePath } from "./rawlog";
import { keptSessions } from "./keep";
import { repoRoot } from "./activity";
import { gitOrNull, readRefs } from "./git";
import { defaultTier, readRecords, TIER_PREFIX, type Tier } from "./record";

interface TierFacts {
  repo: string;
  /** Where a record goes when nobody says. */
  default: Tier;
  /** Whether `git push` will carry shared records at all. */
  pushConfigured: boolean;
  remote: string | null;
  private: {
    records: number;
    /** Raw events captured by the hooks for this repository. */
    captured: { events: number; bytes: number };
    /** Claude Code's own session history, which backfill can read. */
    transcripts: { files: number; bytes: number };
    /** Rows of the injection log: every time a record was, or was not, shown. */
    metrics: number;
  };
  shared: {
    records: number;
    /** Shared records a remote already has. */
    pushed: number;
    /** Shared records the next `git push` will send. */
    waiting: number;
    /** Records that arrived from teammates. */
    fromTeammates: number;
  };
}

/** Lines of a JSONL directory that name this repository, and their bytes. */
function forRepo(files: string[], repo: string): { lines: number; bytes: number } {
  let lines = 0, bytes = 0;
  // Only rows whose repository is this one. Matching the path as text also
  // counted /x/app2 as /x/app, and any command that happened to name it. The
  // text is still a quick first look, in each way the path can be written:
  // on Windows rows name it as git does, C:/x, and the command line as C:\x.
  const here = isRepo(repo);
  const needles = [...new Set([repo, samePath(repo)].flatMap((p) => [p, p.replaceAll("\\", "/")]))].map((p) => JSON.stringify(p).slice(1, -1));
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!needles.some((n) => line.includes(n))) continue;
      try { if (!here((JSON.parse(line) as { repo?: unknown }).repo)) continue; } catch { continue; }
      lines++;
      bytes += line.length + 1;
    }
  }
  return { lines, bytes };
}

/**
 * The remote-tracking copies of records git keeps after a push or fetch, and
 * the object each holds, by the ref's name under refs/anvc/.
 */
function remoteCopies(repo: string) {
  const fetched = readRefs(repo, "refs/remotes/").filter(({ ref }) => /^refs\/remotes\/[^/]+\/anvc\//.test(ref));
  return { fetched, oids: new Map(fetched.map(({ ref, oid }) => [ref.replace(/^refs\/remotes\/[^/]+\/anvc\//, ""), oid])) };
}

/** Shared records the remote does not have yet: what the next push sends. */
export function waitingShared(repo: string): Array<{ ref: string; oid: string }> {
  const { oids } = remoteCopies(repo);
  return readRefs(repo, TIER_PREFIX.shared).filter(({ ref, oid }) => oids.get(ref.slice(TIER_PREFIX.shared.length)) !== oid);
}

export function tierFacts(repo: string): TierFacts {
  const shared = readRefs(repo, TIER_PREFIX.shared);
  const priv = readRefs(repo, TIER_PREFIX.private);
  const { fetched, oids } = remoteCopies(repo);

  // A shared ref counts as pushed when its remote-tracking copy holds the same
  // object. Anything else is waiting.
  const pushed = shared.filter(({ ref, oid }) => oids.get(ref.slice(TIER_PREFIX.shared.length)) === oid).length;
  // By record id, across both tiers. A record moved to private still has its
  // old copy on the remote, and that copy is yours, not a teammate's — even
  // when its bytes differ, as they do for a record written by an older build.
  const mine = new Set(readRecords(repo, [...shared, ...priv]).map(([, r]) => r.id));
  const fromTeammates = readRecords(repo, fetched).filter(([, r]) => !mine.has(r.id)).length;

  const remote = gitOrNull(repo, ["config", "--get", "anvc.remote"])
    || (gitOrNull(repo, ["remote"])?.split("\n").find(Boolean) ?? null);
  const pushSpecs = remote ? gitOrNull(repo, ["config", "--get-all", `remote.${remote}.push`]) ?? "" : "";

  const captured = forRepo(captureFiles(repo), repo);
  const metrics = forRepo(jsonl(metricsRoot()), repo);

  // The copies anvc keeps, which outlast the agents' own.
  const kept = keptSessions(repoRoot(repo) ?? repo);
  const transcriptFiles = kept.length;
  const transcriptBytes = kept.reduce((n, k) => n + k.bytes, 0);

  return {
    repo,
    default: defaultTier(repo),
    pushConfigured: pushSpecs.split("\n").includes("refs/anvc/*:refs/anvc/*"),
    remote,
    private: {
      records: priv.length,
      captured: { events: captured.lines, bytes: captured.bytes },
      transcripts: { files: transcriptFiles, bytes: transcriptBytes },
      metrics: metrics.lines,
    },
    shared: { records: shared.length, pushed, waiting: shared.length - pushed, fromTeammates },
  };
}

export const kb = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
