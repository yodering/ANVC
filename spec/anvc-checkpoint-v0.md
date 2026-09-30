# ANVC checkpoint record, envelope v0

Status: draft, 16 September 2026. Licence: Apache-2.0, like the rest of this
repository.

A checkpoint record says **why** a change was attempted, **what** it did, and
**how it ended** — including when it ended in abandonment. Records are
immutable, append-only, and stored in the repository itself, so they travel with
a clone and survive the service that wrote them.

## Why this exists

Git records what changed and who changed it. It does not record what the author
was trying to do, what else they tried, or what failed. For a human author that
context lives in a PR description or a reviewer's memory. For an agent there is
no PR and no memory: the reasoning exists for one session and is then discarded.

Every funded competitor stores a transcript or nothing. A transcript is a blob a
human must read. This envelope is a record a machine can query.

## Transport and naming

Records live at `refs/anvc/<session>/<seq>`:

- `<session>` is the emitter's session identifier, lowercased, restricted to
  `[a-z0-9-]`.
- `<seq>` is a zero-padded monotonic counter within the session, starting
  `000001`.
- Each ref points at a Git **blob** containing one canonical JSON object.
- Refs are immutable: a ref that exists is never updated, only added to. A
  correction is a new record whose `parent` names the one it supersedes.
- Fetch and push with `refs/anvc/*:refs/anvc/*`. Servers implementing this spec
  advertise that refspec by default.

## The envelope

```json
{
  "anvc": 0,
  "id": "01JD8F2K3M4N5P6Q7R8S9T0V",
  "anchor": { "kind": "commit", "oid": "a1b2c3…" },
  "parent": "01JD8F2K3M4N5P6Q7R8S9T0U",
  "session": {
    "agent": "claude-code",
    "model": "claude-opus-5",
    "run_id": "2638c6c1-e43e-477f-812d-ca7dde9028cb"
  },
  "intent": {
    "goal": "Make ref advertisement fast at 4,096 refs",
    "why": "Reftable manifest conflicts under five concurrent writers",
    "constraints": ["do not change the wire protocol"]
  },
  "actions": [
    { "kind": "read",  "path": "refs/per-ref.ts", "ts": "2026-09-16T14:20:01Z" },
    { "kind": "write", "path": "refs/reftable.ts", "bytes": 4210, "ts": "2026-09-16T14:22:40Z" },
    { "kind": "shell", "command": "bun test tests/refs.test.ts", "exit": 1, "ts": "2026-09-16T14:23:02Z" }
  ],
  "delta": {
    "files": ["refs/reftable.ts", "tests/refs.test.ts"],
    "stats": { "added": 180, "removed": 12 }
  },
  "outcome": {
    "status": "abandoned",
    "tests": { "passed": 47, "failed": 1 },
    "errors": ["manifest conflict under five concurrent writers"]
  },
  "ts": "2026-09-16T14:23:10Z"
}
```

### Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `anvc` | yes | Envelope version. `0` for this draft. A consumer that does not recognise the value must ignore the record, not guess. |
| `id` | yes | ULID. Sortable by creation time, unique without coordination. |
| `anchor` | yes | What this record is about. See below. |
| `parent` | no | `id` of the record this continues or supersedes. Absent for the first record of a line of work. |
| `session.agent` | yes | Emitter identity, e.g. `claude-code`, `codex`, `openhands`, `gemini-cli`, `cursor`. |
| `session.model` | no | Model identifier if the emitter knows it. |
| `session.run_id` | yes | Groups records from one agent session. Maps to `gen_ai.conversation.id`. |
| `intent.goal` | yes* | One line under 200 characters, written by the agent: what this work set out to achieve. The field of record. |
| `intent.why` | no | Why an attempt was abandoned, or anything a future reader needs that the diff does not show. |
| `intent.prompt` | no* | The raw instruction, for provenance and for agents that cannot yet emit. Never shown in place of the goal. |
| `intent.plan` | no | Ordered steps the agent stated it would take. |
| `intent.constraints` | no | Stated limits: do not touch X, keep the API stable. |
| `actions` | no | Ordered `read`, `write`, `shell` entries. `read` entries are what make file-overlap measurable; the Git wire cannot see them. |
| `delta.files` | no | Paths the record changed. A **list**, not a count: overlap and blame-by-intent both need the paths. |
| `delta.stats` | no | Lines added and removed. |
| `outcome.status` | yes | `kept` or `abandoned`. |
| `outcome.tests` | no | Passed and failed counts if a test run was observed. |
| `outcome.errors` | no | Error strings, redacted, that explain an `abandoned` status. |
| `ts` | yes | RFC 3339 UTC when the record was sealed. |

### `anchor`

```json
{ "kind": "commit", "oid": "<sha>" }   // became a commit
{ "kind": "blob",   "oid": "<sha>" }   // never became a commit
{ "kind": "tree",   "oid": "<sha>" }   // a working state, not committed
```

An attempt that was abandoned never produces a commit. Anchoring to a
pack-resident blob or tree keeps the record addressable anyway, which is the
whole point: **abandoned work is the asset, and it is exactly what a
commit-anchored design cannot hold.**

### `outcome.status = "abandoned"`

A record is abandoned when its changes did not reach the anchor's history: the
files were reverted, the branch was deleted, or the session ended without a
commit. Emitters mark this at session end by comparing `delta.files` against the
working tree and the ref log.

This is the only field in the envelope with no equivalent anywhere else, and the
reason the F1 queries can answer "what has already been tried and failed" rather
than only "what shipped".

## Alignment with existing work

Field names match OpenTelemetry GenAI semantic conventions where they overlap:
`session.run_id` is `gen_ai.conversation.id`, `session.agent` is
`gen_ai.agent.id`, `session.model` is `gen_ai.request.model`. An emitter already
producing OTel GenAI spans can map without inventing names.

The record shape is compatible with in-toto attestation: `intent` is the
predicate, `anchor` the subject. A future `v1` may add a `signature` field for
that path. v0 does not sign.

`git-ai` proposes commit-message trailers for agent metadata. Trailers cannot
hold abandoned attempts, because an abandoned attempt has no commit. Convergence
is worth pursuing on the shared fields and is tracked as an M7 task.

## The agent writes its own record

`goal` is written by the agent that did the work, at the moment it finishes or
abandons a unit of work, through the `anvc_checkpoint` tool. This is the core of
"agent native" and it is not a stylistic choice.

The agent read the files, ran the commands, and decided to back the change out.
It is the only party holding that context. A second model summarising the
transcript afterwards has **strictly less** information than the agent that just
did the work, and adds a dependency, a cost, and a failure mode for nothing.
Agents already write commit messages; writing a goal is the same act.

A raw prompt is **input**, not an artifact. It is long, it is conversational, it
contains whatever the user happened to say, and it may contain material the user
would never put in a repository. Version control stores commit messages rather
than keystrokes for the same reason.

`*` One of `goal` or `prompt` is required. Captured records from an agent with
no emitter carry `prompt` alone and are marked as captured wherever they are
shown, so a reader can tell a stated goal from a scraped one.

## Redaction

Emitters redact **before writing**, never after. Minimum: credential shapes
(GitHub, OpenAI-style, AWS, JWT), keyword-adjacent values (`password`, `secret`,
`token`, `api_key`), and high-entropy tokens over 32 characters. A record that
still trips a detector is dropped and logged, not stored: an immutable
append-only store has no way to unpublish a leaked secret.

## Size

A record is capped at 64 KiB. `intent.prompt` is capped at 8 KiB and
`actions` at 1,000 entries; an emitter that exceeds either truncates and sets
`"truncated": true`. Records are not a transcript store, and a design that
invites 48 KiB blobs per turn recreates the problem it is meant to solve.

## What v0 deliberately omits

- **No signatures.** Provenance needs them; measurement does not. Deferred to v1
  so v0 can ship and be tested.
- **No embeddings.** Retrieval is keyword and structured-field first. An
  embedding index is an optional server-side addition, off by default.
- **No cross-repository links.** A record refers to one repository.
- **No schema negotiation.** A consumer reads `anvc` and either understands the
  version or ignores the record.
