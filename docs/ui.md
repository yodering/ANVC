# The work log

```bash
bun run ui                      # this checkout's log, in the browser
bun run ui --repo ../project    # another repository's log
bun run ui --no-browser         # prints http://127.0.0.1:7451/?t=…
bun run ui --port 7010          # a port of your own
bun run ui --restart            # after editing the page's files
```

`bun run ui` is `anvc open` run from the clone, so the repository is `--repo`,
then the ANVC checkout. It starts a detached server and waits for it to
answer; running it again for the same repository finds that server. Its log
is in `~/.anvc/state/ui/`. After editing the page's files, `--restart` stops
that server and starts one that bundles them again.

Every request needs a token, so other users on this computer can't read the
records or change settings through the page. Opening the printed link once
stores it in a cookie and takes it out of the address bar. The token lives in
`~/.anvc/state/ui-token` and stays the same across restarts, so a bookmark
keeps working. Scripts send it in an `x-anvc-token` header, and
`ANVC_UI_TOKEN` overrides it; the desktop app passes a new one each launch.
`anvc open` starts the browser with a code in the link instead of the token,
since any user can read a command's arguments; the server accepts each code
once, within a minute.

## Using the workspace

The work list shows attempts newest first, without session heading rows.
The sidebar lists recent sessions. Choose one to focus its attempts, or use
All work, Kept, and Abandoned to filter by outcome. On a phone, the session
selector sits above search. Search matches all entered words against goals,
paths, commands, reasons, and captured instructions.

Select an attempt to read its outcome, related attempts, constraints, files, and activity.
When the record carries a dense half, the panel also shows what happened, the
verbatim output, what was ruled out and why, what was not checked, the
`recheck` command, and the commands run. Each section is omitted when empty.
Date, duration, and source appear at the bottom of the detail panel.
Related attempts appear beneath the outcome; select one to follow the chain.
Following a related attempt clears filters so its row is visible. Each
activity step expands to show its full evidence. The detail panel sits next to
the list on desktop and fills the screen on a phone. Escape closes it and
returns focus to the selected attempt. `/` focuses search; Escape also clears
search or filters when no detail is open.

The API currently returns the latest 40 attempts. When more records exist, the
page states that search and filters cover only that recent set. Repository
summary counts remain totals; filter counts use the selected session.

Records refresh every ten seconds without clearing search or selected details.
Failed refreshes retain the previous data and show a retry action. Loading,
empty repositories, and searches without results have separate states.

## Private and shared

Every attempt belongs to one of two tiers. A private attempt shows a lock in the
work log; a shared one shows nothing, since shared is the usual case. The detail
panel names the tier and the command that changes it, with a copy button.

`GET /api/tiers` returns the counts per tier: private records, captured events,
Claude Code transcripts and injection log rows; shared records, how many are
pushed and how many wait for the next push.

## Tour

A six-step tour opens on the first visit and from "How it works" in the
sidebar: attempts, the two tiers, private, shared, sharing, and depth. Its
numbers come from `/api/tiers`. Arrow keys move between steps; Escape closes
it. Closing it once stores that it was seen, in browser storage.

## First use

Connect an agent opens setup instructions for the MCP server and
`anvc_checkpoint`. It does not edit the agent's configuration. The
instructions depend on how ANVC is installed: `/anvc:setup` for the Claude
Code plugin, `bun run setup` in a clone, and the plugin's install commands in
the desktop app. Every command the page shows runs the CLI by its path, or
the plugin's slash command where there is one.

View example opens an explicitly labeled, in-memory ANVC work history with
plausible attempts, abandoned approaches, and their successors.
`?example=1` links directly to it. The example never writes Git refs or changes
repository data. Back to my repository returns to the real records.

Agent-written goals are distinguished from captured instructions. A captured
turn gets a title derived from its recorded actions; the raw instruction stays
behind a disclosure in the details. See the [checkpoint spec](../spec/anvc-checkpoint-v0.md).

## Frontend structure

- `server/ui.tsx`: workspace, setup dialog, work rows, and attempt details.
- `server/work-model.ts`: filtering, session grouping, labels, and forge links.
- `server/widgets.tsx`: icons, outcome badges, timeline, and section labels.
- `server/example-work.ts`: opt-in example data.
- `server/ui.css`: dark canvas, amber selection, ruled work lists, responsive
  layouts, and motion tokens. Outcome colors retain semantic names.
- `server/icons.tsx`: inline Lucide SVG sprite.

Preact preserves component state across polling. Bun bundles TSX and CSS from
`server/ui.html`, with no separate build command. Detail entry uses a short
opacity/position transition, disabled by the reduced-motion preference.

## Boundaries

Code review stays on the forge. File links use the recorded commit when one
exists and otherwise use HEAD; absolute paths are displayed without a link.
No separate file browser, commit browser, or diff view is planned.

The viewer handles one repository at a time. It does not infer costs or agent
identities that the API does not provide. Captured records anchor to HEAD at
ingest time; agent-written records can supply their own commit anchor.

`GET /api/repo` provides the work view.
