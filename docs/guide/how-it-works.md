# How it works

## Records

When an agent finishes or gives up on something, it calls `anvc_checkpoint`
with a one-line description of what it was trying to do, much like a commit
message. ANVC doesn't try to summarise your prompts, because a prompt like
"just continue until u need me" tells nobody anything months later.

If a session ends and the agent recorded nothing, ANVC saves what its log saw
instead: the commands, the files and what failed. Only the agent can say why,
so these are marked "No reason" in the work log, with their own tab and a
count above the list. They're private.

ANVC also keeps what agents read, so a later session can read it again
instead of fetching it: each page fetched with WebFetch and the prompt run on
it, each WebSearch, and each PDF, along with notes and data files (.md, .txt,
.tex, .html, .csv and the like) that git doesn't keep, because they're outside
the repository or untracked in it. Each is kept with the text the agent got
back, secrets taken out, up to 64 KiB with the middle left out past that. A
PDF's text is read with `pdftotext` when it's installed. The Sources tab, on the Results page, lists
them with the attempts and results from the same session and any record that
names their URL or path, and agents look them up with `anvc_sources`. They stay
on this computer; Sources in Settings turns them off.

Each record is a small JSON file stored as a git ref, `refs/anvc/<session>/<seq>`.
It says what the goal was, whether the work was kept or abandoned and why,
which files changed, and which earlier attempt it replaced, if any. Records
are never edited. A correction is a new record that points at the old one.

Setup adds three lines to your git config, so an ordinary `git push` sends
records and `git fetch` brings back your teammates'. Records are plain git
refs, so any git host that accepts extra refs can carry them. We've tested
GitHub, which stores them without knowing what they are; GitLab, Bitbucket and
others haven't been tested yet. `anvc init` adds the same lines without the
rest of setup.

In Claude Code, ANVC shows the agent relevant dead ends without being asked:
when it opens a file that has one, and a short list when a session starts. It
says nothing otherwise, because adding unrelated context to every prompt costs
time and money without helping the agent.

## The Project page

The Project page has four tabs, and your agent is given the same four things
when a session starts and again after its context is compacted. Each can be
switched off in Settings, under Your agent.

- **Status** lists what each session and subagent is working on now, what was
  finished recently and where it stands (not committed, only on this
  computer, in main, pushed or released), and what's up next. The agent adds
  an item to Up next when you ask for something it won't start right away,
  and marks items doing and done with `anvc_status_item`. You can add, edit,
  reorder and drop them on the page.
- **Goals** holds the project's goals and sub-goals, each To do, In progress,
  Done or Dropped. The agent changes them with `anvc_goal` and links the
  attempts it records to the sub-goal they served. Every change is a new
  record saying who made it and why, so a goal keeps its history, and Undo is
  one more change. Approve goals, in Settings, makes an agent's changes wait
  for you.
- **Writing rules** points at where the rules for each kind of text are
  written, usually a heading in AGENTS.md, and says which files, or `commit`,
  they cover. The agent gets the list when a session starts. In Claude Code it
  also gets a rule set's text right before it edits a covered file or runs
  `git commit`. The rules stay in your file; ANVC keeps only the pointer.
- **Tools** lists each agent's MCP servers, plugins, skills, commands and
  hooks, read from that agent's own config files, and whether each is on.
  ANVC never changes them. A note on a tool says when to use it, and agents
  are given the notes.

Goals, status items, rule sets and tool notes are records like attempts, so
they're shared or private by the same settings, and travel with git push once
that's on.

## What it doesn't do

- It isn't a git host. Your code stays on GitHub, GitLab, or wherever it is
  now.
- It doesn't show diffs or pull requests. File and commit names in the work
  log link to your forge for that.
- It doesn't use a second model to summarise sessions. The agent that did the
  work writes the record, and it knows more about the work than anything
  reading the transcript afterwards.
- It doesn't show agents everything it has, only what matches the file or task
  in front of them.
