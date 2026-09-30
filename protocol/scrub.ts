/**
 * Redacts secrets from anything before it is written down.
 *
 * Lifted out of the capture hook when a second reader appeared. Backfill reads
 * months of transcripts, which is far more text than a live session ever hands
 * over, and a second copy of a redaction rule is a second place for one to go
 * missing.
 */
/**
 * Cap before matching. This is the primary defence against catastrophic
 * backtracking: a hostile or merely huge paste makes the patterns below
 * quadratic, and a capture hook that burns CPU blocks the agent. The cap runs
 * first so the regexes never see more than this.
 *
 * Adapted from claude-mem's error-scrub (Apache-2.0) — see
 * docs/decisions/2026-09-17-provenance.md.
 */
const MAX_SCRUB_CHARS = 8192;

/**
 * Credential shapes, and what each is replaced with.
 *
 * One list for three readers: the raw log's scrub, every record before it is
 * written, and the pre-push check. There were two copies, and the push check's
 * had drifted: it missed URL passwords, non-JWT bearer tokens and a .env
 * password that the scrub caught.
 *
 * Named shapes only, and each match starts with the part that is not secret
 * (a prefix, a scheme, a variable name), because the push check prints the
 * first characters of what it found. The entropy rule is left out: every
 * record carries commit and record ids that look exactly like random tokens,
 * and a check that stops every push is a check people turn off.
 *
 * Order matters: credentials inside a URL are stripped first, because
 * `postgres://admin:pw@host` has no keyword next to the password and no
 * separator the entropy pass would split on — it leaked entirely until this
 * ran first. No replacement matches again, so redacting twice is the same as
 * redacting once.
 */
const SECRET_SHAPES: Array<{ kind: string; shape: RegExp; by: string }> = [
  // Any scheme, not just http: postgres://, redis://, mongodb+srv://, amqp://.
  // The username goes too: it is half a credential.
  { kind: "password in a URL", shape: /\b([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)(?!\[redacted)[^/@\s:]*:[^/@\s]+@/g, by: "$1[redacted:url]@" },
  // The whole block, also when JSON has escaped its newlines, and up to the
  // end of the text when the output was cut before the END line.
  { kind: "private key", shape: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]{0,10000}?-----END [A-Z0-9 ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s\\]*)/g, by: "[redacted:private key]" },
  { kind: "private key", shape: /("private_key"\s*:\s*")(?!\[redacted)[^"]+/g, by: "$1[redacted:private key]" },
  // A digit, an = or 24 characters, since "basic functionality" is prose.
  { kind: "bearer token", shape: /\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9=]|[A-Za-z0-9._~+/=-]{24})[A-Za-z0-9._~+/=-]{8,512}/gi, by: "$1 [redacted:auth]" },
  { kind: "GitHub token", shape: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, by: "[redacted:github]" },
  { kind: "GitHub token", shape: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, by: "[redacted:github]" },
  { kind: "GitLab token", shape: /\bglpat-[A-Za-z0-9_-]{20,}/g, by: "[redacted:gitlab]" },
  { kind: "Hugging Face token", shape: /\bhf_[A-Za-z0-9]{30,}/g, by: "[redacted:huggingface]" },
  { kind: "npm token", shape: /\bnpm_[A-Za-z0-9]{36}/g, by: "[redacted:npm]" },
  { kind: "OpenAI or Anthropic key", shape: /\bsk-[A-Za-z0-9_-]{20,}/g, by: "[redacted:key]" },
  { kind: "AWS access key", shape: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, by: "[redacted:aws]" },
  { kind: "JWT", shape: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, by: "[redacted:jwt]" },
  { kind: "Slack token", shape: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, by: "[redacted:slack]" },
  { kind: "Slack webhook", shape: /(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g, by: "$1[redacted:slack]" },
  { kind: "Google API key", shape: /\bAIza[0-9A-Za-z_-]{35}/g, by: "[redacted:google]" },
  { kind: "Stripe key", shape: /\b[sr]k_live_[0-9A-Za-z]{16,}/g, by: "[redacted:stripe]" },
  { kind: "Azure key", shape: /\b((?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/=]{20,}/g, by: "$1[redacted:azure]" },
  { kind: "Azure key", shape: /([?&]sig=)[A-Za-z0-9%+/=]{20,}/g, by: "$1[redacted:azure]" },
  { kind: "password on a command line", shape: /(\bcurl\b[^\n|;&]*?\s(?:-u|--user)[=\s]?\s*["']?)(?!\[redacted)[^\s"':]+:[^\s"']+/g, by: "$1[redacted:auth]" },
  { kind: "password on a command line", shape: /(\b(?:mysql|mariadb)[a-z-]*\b[^\n|;&]*?\s-p)(?!\[redacted)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g, by: "$1[redacted]" },
  // DB_PASSWORD=hunter2, "api_key": "...", aws_secret_access_key = ...: a
  // value given to a secret's name. Four characters, because a short password
  // is still a password; never a type name, a variable reference or a number,
  // because `token: string` and `max_tokens=4096` are code.
  {
    kind: "password or key after its name",
    shape: /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)(?:[_-]?(?:access[_-]?)?key)?["']?[ \t]*[:=][ \t]*["']?)(?!\[redacted|[$<%{]|(?:string|number|boolean|null|undefined|none|true|false|str|int|bool|any|process\.env|os\.environ|getenv)\b)(?=[^\s"'`,;)}\]]*[^\d\s"'`,;)}\].])[^\s"'`,;)}\]]{4,}/gi,
    by: "$1[redacted]",
  },
];

/** Every named credential shape in a text, redacted. What a record gets, since its ids and hashes must survive. */
export const redactSecrets = (text: string): string =>
  SECRET_SHAPES.reduce((out, { shape, by }) => out.replace(shape, by), text);

/**
 * Redaction for the raw log: the named shapes, then looser rules that suit a
 * private log and are too eager for a record, where they would rewrite
 * "basic functionality" or stop a push over "the password reset flow".
 */
function redact(text: string): string {
  return redactSecrets(text)
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?!\[redacted)[^/@\s]+@/g, "$1[redacted:url]@")
    // Case-insensitive: a lowercase token carries exactly as much as a mixed one.
    .replace(/\b(bearer|basic)\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{8,512}/gi, "$1 [redacted:auth]")
    .replace(/(?<=(password|passwd|secret|token|api[_-]?key)["'\s:=]{1,4})(?!\[redacted)\S{8,}/gi, "[redacted]");
}

/**
 * High-entropy long tokens that the patterns above miss.
 *
 * The distinct-character ratio alone missed real secrets: an AWS secret key is
 * 40 characters of base64 with plenty of repeats, and its ratio sits below the
 * threshold. A long base64url run containing a digit is secret-shaped whatever
 * its entropy, so that shape is caught separately.
 */
function entropySuspect(value: string): boolean {
  if (value.length < 32 || /\s/.test(value)) return false;
  if (/^[A-Za-z0-9+/_-]{32,4096}={0,2}$/.test(value) && /\d/.test(value)) return true;
  const set = new Set(value);
  return set.size / value.length > 0.55 && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * `cap` exists because output is scrubbed too, and output is allowed to be
 * larger than a prompt.
 *
 * The default guards against catastrophic backtracking on a hostile paste. For
 * command output the guard still has to hold, but truncating at 8 KiB would
 * mean the secret-scrubber's performance limit silently decided how much of a
 * stack trace survives — a limit chosen for one reason quietly enforcing
 * another. The shape-based trim is what should decide that, so this is raised
 * and the trim runs after.
 */
export function scrub(text: string, cap = MAX_SCRUB_CHARS): string {
  return redact(text.length > cap ? text.slice(0, cap) : text)
    // Split on separators as well as whitespace, so `KEY=<secret>` and
    // `--token=<secret>` present the secret as its own token.
    .split(/([\s=:,;]+)/)
    .map((token) => (pathLike(token) ? scrubPath(token) : entropySuspect(token) ? "[redacted:entropy]" : token))
    .join("");
}

/**
 * A filesystem path is judged one folder name at a time.
 *
 * Whole, a path is a long run of letters, digits and slashes, which is the
 * shape of base64, so /tmp/claude-1000/<session id>/scratchpad was blanked out
 * as a secret: the one part of a record that says where something is. A
 * UUID-shaped folder name is a name. A key sitting in a path segment is still
 * caught.
 */
const pathLike = (token: string) => /^(~|\.{1,2})?\//.test(token) && (token.match(/\//g) ?? []).length >= 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scrubPath = (token: string) =>
  token.split("/").map((part) => (!UUID.test(part) && entropySuspect(part) ? "[redacted:entropy]" : part)).join("/");

/** Every credential shape in a text, with the match shortened so it is never printed whole. */
export function findSecrets(text: string): Array<{ kind: string; sample: string }> {
  const out: Array<{ kind: string; sample: string }> = [];
  for (const { kind, shape } of SECRET_SHAPES) {
    // match, not exec: a global pattern's exec resumes from the last call.
    const m = text.match(shape);
    if (m) out.push({ kind, sample: `${m[0].slice(0, 6)}…` });
  }
  return out;
}
