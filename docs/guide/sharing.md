# Private and shared

Everything ANVC keeps is either private or shared.

| | Private | Shared |
|---|---|---|
| Where | this machine | your git remote |
| Holds | every command and its output, files read and edited, your prompts, Claude Code's session history, scraped records | records agents wrote on purpose |
| Pushed? | never | with your next `git push` |
| Read by | your agent | your agent, and teammates' agents after a fetch |

```
refs/anvc/<session>/<seq>           shared — one immutable JSON blob per attempt
refs/anvc-private/<session>/<seq>   private
~/.anvc/capture/                    private — raw events from the hooks
```

Setup only pushes refs under `refs/anvc/`, so private refs under
`refs/anvc-private/` never leave your machine.

**How much ANVC tells your agent.** Everything shown to an agent unasked
changes what it does, so this is yours to choose, once for every project and
per project if you like: *Automatic* (past attempts at session start, on each
prompt, when a command fails and when a subagent starts), *At the start*
(briefed once, then quiet) or *When asked* (nothing unless you or the agent
ask; work is still saved). Each moment has its own switch under Settings,
and from a terminal: `bun run anvc assist start --everywhere`, or `bun run
anvc assist set prompts off` for one project.

**Local only.** For a repository with no remote, or whose records should never
leave your computer, turn on Local only in Settings or run `bun run anvc local
on`. Every record is then private, ANVC's push and fetch settings come off
every remote, and `anvc init`, `anvc share` and `anvc sync` refuse. Choosing a
preset doesn't change it. Turning it off sends nothing: records made while it
was on stay private, and sharing starts again only after `anvc init`.

Records an agent writes are shared by default. Records saved from the log,
by `ingest` or `backfill`, are private, since nobody has reviewed them. To make a repository
private by default: `bun run anvc policy tier private`, or pick it under
Settings in the app.

Before a record is shared, paths are made relative to the repository and your
prompts are removed.

```bash
bun run anvc tiers              # counts per tier, and what the next push sends
bun run anvc share <id>         # share a private record
bun run anvc unshare <id>       # make a record private
bun run anvc unshare --captured # make every scraped record private
```

An agent can mark a record private, but only you can share one.

`unshare` moves a record on this machine. A copy already pushed stays on the
remote until you delete it there: `git push origin --delete <ref>`.

ANVC also keeps a search index built from the refs. It's safe to delete, since
it rebuilds itself.
