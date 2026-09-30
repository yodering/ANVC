/**
 * Secrets must not reach a capture file.
 *
 * Capture files become immutable git refs, so a leak here is permanent and
 * travels with every clone. These four shapes all leaked until 2026-09-17:
 * credentials inside a URL have no keyword beside them and no separator to
 * split on, a lowercase Bearer token has too little entropy for the ratio
 * test, and an AWS secret key is 40 base64 characters with enough repeats to
 * sit under the same threshold.
 *
 * The approach is adapted from claude-mem's error-scrub (Apache-2.0); see
 * docs/decisions/2026-09-17-provenance.md.
 */
import { expect, test } from "bun:test";
import { git, gitRepo, rawText, rec, tmp } from "./helpers";
import { readRefs } from "../protocol/git";
import { resolve } from "node:path";

const CAPTURE = resolve(import.meta.dir, "../emitters/claude-code/capture.ts");

/** Runs the real hook the way Claude Code does, and returns what it wrote. */
async function capture(prompt: string): Promise<string> {
  const dir = tmp("anvc-redact-");
  const repo = gitRepo();
  const proc = Bun.spawnSync(["bun", CAPTURE, "UserPromptSubmit"], {
    stdin: new TextEncoder().encode(JSON.stringify({
      hook_event_name: "UserPromptSubmit", prompt, cwd: repo, session_id: "sess-redact",
    })),
    env: { ...process.env, ANVC_CAPTURE_DIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  return rawText(dir);
}

test("credentials inside a URL never reach the capture file", async () => {
  const written = await capture("psql postgres://admin:hunter2password@db.internal:5432/prod");
  expect(written).not.toContain("hunter2password");
  // The username is half a credential, so it must not survive either.
  expect(written).not.toContain("admin:");
  // The host is not a secret and is what makes the record useful.
  expect(written).toContain("db.internal");
}, 30_000);

test("an all-lowercase Bearer token is still a token", async () => {
  const written = await capture("curl -H 'Authorization: Bearer lowercaseonlytokenwithnodigits'");
  expect(written).not.toContain("lowercaseonlytokenwithnodigits");
}, 30_000);

test("a pasted .env line does not store its value", async () => {
  const written = await capture("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  expect(written).not.toContain("wJalrXUtnFEMI");
  // The variable name is worth keeping: it says what was configured.
  expect(written).toContain("AWS_SECRET_ACCESS_KEY");
}, 30_000);

test("provider key shapes are caught by name", async () => {
  const written = await capture("export OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345");
  expect(written).not.toContain("sk-proj-abc123");
}, 30_000);

test("ordinary work is stored unchanged", async () => {
  const written = await capture("fix the FTS5 escaping in protocol/query.ts so paths match");
  // Over-redaction would make the log useless, which is the other failure mode.
  expect(written).toContain("protocol/query.ts");
  expect(written).toContain("FTS5 escaping");
}, 30_000);

test("a path keeps its folder names, and a secret inside a path is still caught", async () => {
  const { scrub } = await import("../protocol/scrub");
  const path = "/tmp/claude-1000/-home-sam-code-shop/5b7e0c4a-91d2-4f3e-8a6b-2c9d1e7f4a30/scratchpad";
  expect(scrub(`cd ${path} && ls`)).toBe(`cd ${path} && ls`);
  expect(scrub("cat /srv/keys/AbCdEf0123456789GhIjKl0123456789MnOpQr/config")).toContain("[redacted:entropy]");
});

// Fixtures shaped like credentials and valid for nothing, put together so
// this file holds no credential-shaped string of its own.
const FAKE = "FAKEfake0000";
const PEM = `${["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")}\nMIIE${FAKE}\n${FAKE}==\n${["-----END", "RSA PRIVATE KEY-----"].join(" ")}`;
const SHAPES: Array<[string, string, string]> = [
  // What it is, the text, and the part that must not survive.
  ["a PEM block", `key:\n${PEM}\nafter`, FAKE],
  ["a PEM block inside JSON", JSON.stringify({ key: PEM }), FAKE],
  ["a PEM block cut before its END line", PEM.split("\n").slice(0, 2).join("\n"), FAKE],
  ["a service account's private_key", JSON.stringify({ type: "service_account", private_key: `${FAKE}${FAKE}` }), FAKE],
  ["a Slack webhook", `curl -X POST https://${["hooks", "slack", "com"].join(".")}/services/T0/B0/${FAKE}${FAKE}`, FAKE],
  ["curl -u", `curl -u admin:${FAKE} https://api.example.com`, FAKE],
  ["mysql -p", `mysql -u root -p${FAKE} prod`, FAKE],
  ["mysql -p with quotes", `mysql -u root -p'two ${FAKE}' prod`, FAKE],
  ["a short password after its name", "DB_PASSWORD=hunter2", "hunter2"],
  ["an AWS secret key", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["a GitLab token", `glpat-${FAKE}${FAKE}`, FAKE],
  ["a Hugging Face token", `hf_${FAKE}${FAKE}${FAKE}`, FAKE],
  ["an npm token", `npm_${FAKE}${FAKE}${FAKE}`, FAKE],
  ["an Azure account key", `AccountName=acct;AccountKey=${FAKE}${FAKE}==;EndpointSuffix=core.windows.net`, FAKE],
  ["a password in a URL", `postgres://admin:${FAKE}@db.internal/prod`, FAKE],
  ["a bearer token that is not a JWT", `Authorization: Bearer ${FAKE}`, FAKE],
];

test("every named credential shape is redacted, and found by the push check", async () => {
  const { findSecrets, redactSecrets, scrub } = await import("../protocol/scrub");
  for (const [what, text, secret] of SHAPES) {
    expect({ what, found: findSecrets(text).length > 0 }).toEqual({ what, found: true });
    expect({ what, kept: redactSecrets(text).includes(secret) }).toEqual({ what, kept: false });
    expect({ what, kept: scrub(text).includes(secret) }).toEqual({ what, kept: false });
    // Redacted text isn't found again, so a record redacted once can be pushed.
    expect({ what, again: findSecrets(redactSecrets(text)) }).toEqual({ what, again: [] });
  }
});

test("ordinary text, code, hashes and ids are left alone", async () => {
  const { findSecrets, redactSecrets } = await import("../protocol/scrub");
  for (const text of [
    "Add basic functionality for the password reset flow",
    "The secret is that the token budget matters",
    "interface Login { token: string; password: string | null }",
    "max_tokens=4096, tokens: 1200",
    "password = process.env.DB_PASSWORD",
    "git@github.com:org/repo.git and ssh://git@github.com/org/repo.git",
    "commit 0123456789abcdef0123456789abcdef01234567, record 01M3N1T50AQFRZ9MTHVG68253R",
    "mysql -u root -p prod",
  ]) {
    expect(redactSecrets(text)).toBe(text);
    expect(findSecrets(text)).toEqual([]);
  }
});

test("a record is redacted where it is written, in either tier, and keeps its ids", async () => {
  const { appendRecord, readRecord } = await import("../protocol/record");
  const repo = gitRepo({ commit: true });
  const commit = git(repo, "rev-parse", "HEAD");
  for (const tier of ["shared", "private"] as const) {
    const record = rec({
      intent: { goal: "Call the pricing API", why: `it worked once DB_PASSWORD=${FAKE} was set` },
      outcome: { status: "abandoned", recheck: `curl -u admin:${FAKE} https://api.example.com`, errors: [`401 for Bearer ${FAKE}`] },
      evidence: [{ commit, note: `glpat-${FAKE}${FAKE}` }],
      detail: { output: `connecting to postgres://admin:${FAKE}@db/prod`, commands: [`mysql -p${FAKE}`] },
      map: { part: "billing", does: "Charges cards", decisions: [{ what: "one key", because: `AccountKey=${FAKE}${FAKE}==` }] },
    });
    const { ref, oid } = appendRecord(repo, record, { tier });
    // Every copy: a shared write also keeps a full one here when the policy held something back.
    for (const { oid: copy } of [{ oid }, ...readRefs(repo, "refs/anvc-private/")]) {
      expect(git(repo, "cat-file", "blob", copy)).not.toContain(FAKE);
    }
    const stored = readRecord(repo, ref);
    expect([stored.id, stored.anchor, stored.evidence?.[0]?.commit, stored.ts]).toEqual([record.id, record.anchor, commit, record.ts]);
    expect(stored.intent.why).toBe("it worked once DB_PASSWORD=[redacted] was set");
  }
});
