# Removing ANVC

## From one project

```bash
bun run anvc off         # stop for now; nothing is saved or shown here
bun run anvc uninstall   # take out what setup added
```

`anvc uninstall` turns ANVC off for the folder, so hooks installed for every
project skip it, and removes what setup added there: the three lines of git
config, ANVC's entries in each agent's hook file, Cursor's MCP entry, the
files that held nothing else, the pre-push check and the project's ANVC
settings. Your own hooks stay.

Two things stay unless you ask, because they're yours:

```bash
bun run anvc uninstall --records        # also delete this clone's records
bun run anvc uninstall --instructions   # also remove the lines from AGENTS.md or CLAUDE.md
```

Records already pushed stay on the remote until you delete them there. A
teammate who already fetched them keeps their copy.

```bash
git push origin --delete $(git ls-remote origin 'refs/anvc/*' | cut -f2)
```

## Remove and restore

To take ANVC out of a project for a while, records on the remote included,
and bring it all back later:

```bash
bun run anvc remove                   # back up, delete this clone's records, then uninstall
bun run anvc remove --remote origin   # also delete them on origin; --remote all for every remote that has some
bun run anvc restore                  # list this project's backups
bun run anvc restore <file> --setup   # bring one back, with what setup had changed
```

The backup is one file in `~/.anvc/backups/`, named for the project and the
time, that only you can read. It's a git bundle of every ANVC ref in the
clone, with the project's settings from `.git/anvc` inside. Remove writes it,
runs `git bundle verify` on it and reads every ref back from it before it
deletes anything. If any of that fails, nothing is deleted.

With `--remote`, records on the remote that this clone never fetched are
fetched first, so the backup has them too. Only ANVC's refs are deleted
there; branches and tags stay. Remove says how many it will delete and where,
and asks first; without a terminal it needs `--yes`. Anyone who already
fetched the records keeps their copy.

`--keep-setup` deletes the records and leaves setup's changes in place.
`--instructions` also takes the lines out of AGENTS.md or CLAUDE.md.

Restore brings back the refs and the settings. A ref or settings file that
changed after the backup is left as it is here, and restore names it. It
doesn't push: it prints the `git push` that puts the records back on the
remote. `--setup` turns ANVC back on for the folder and puts back the git
config, the pre-push check and, from a clone of ANVC, the hooks setup wrote
for each agent.

Settings in the work log has both, under Remove ANVC and Restore. Deleting on
a remote there needs its name typed.

## From every project

```bash
bun run anvc uninstall --everywhere --dry-run   # what it would take out
bun run anvc uninstall --everywhere
```

This undoes `setup --global` in each agent's own config. It takes the plugin
out of `~/.claude/settings.json`, ANVC's hooks out of that file,
`~/.codex/hooks.json` and `~/.cursor/hooks.json`, and the `anvc` MCP server
out of `~/.claude.json`, `~/.codex/config.toml` and `~/.cursor/mcp.json`.
Only ANVC's entries go: a hook counts as ANVC's when its command runs a file
under `emitters/claude-code/`, and a server when it's named `anvc`. The
Folders page in the work log does the same from its Remove button, and shows
this list first.

Records stay in each project unless you add `--records`. Projects set up one
at a time keep their own hooks; run `anvc uninstall` in each of those. The
plugin's files stay in Claude Code until you run `/plugin uninstall anvc@anvc`
there. Where `~/.codex/config.toml` lists the server in a form ANVC doesn't
rewrite, it says so and leaves it for `codex mcp remove anvc`.

`~/.anvc/` holds the raw log, settings, metrics and backups for every
project. Delete it, and your clone of ANVC, once no project uses it.

## By hand

What `anvc uninstall` does, if you'd rather do it yourself. Setup added three
lines to `remote.origin`:

```bash
git config --fixed-value --unset remote.origin.fetch '+refs/anvc/*:refs/remotes/origin/anvc/*'
git config --fixed-value --unset remote.origin.push 'refs/anvc/*:refs/anvc/*'
git config --fixed-value --unset remote.origin.push HEAD
```

The last one puts `git push` back to git's default. If your remote had
`push = refs/heads/*:refs/heads/*` before, setup removed it, because with it a
plain `git push` sent every local branch. Add it back if you wanted that.

In `.claude/settings.local.json` for Claude Code, `.codex/hooks.json` for
Codex, or `.cursor/hooks.json` for Cursor, delete every hook whose command
runs a file under `emitters/claude-code/`, and the `anvc` entry in
`.cursor/mcp.json`. Records are deleted from a clone with:

```bash
git for-each-ref --format='delete %(refname)' refs/anvc/ refs/anvc-private/ refs/remotes/origin/anvc/ | git update-ref --stdin
```
