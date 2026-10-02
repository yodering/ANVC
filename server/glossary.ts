/**
 * What the words in this UI mean, in plain language.
 *
 * Every term here was invented by this project — "anchor", "captured",
 * "recheck command" — and a reader has no way to guess them. An entry is shown
 * only where the page names its key, in a `hint=` or a `<Hint id=>`.
 *
 * Written to be read once and never again: no jargon explaining jargon, and
 * long enough to be unambiguous rather than short enough to look tidy.
 */
export interface Hint {
  /** The short label the reader clicked. */
  term: string;
  /** One sentence that answers "what is this". */
  what: string;
  /** Why it is worth their attention, when that is not obvious. */
  why?: string;
}

export const HINTS: Record<string, Hint> = {
  "hub-results": { term: "Results", what: "The numbers your project relies on, each with the command and files that made it. ANVC flags one when what it depends on changes." },
  "hub-sources": { term: "Sources", what: "The pages, web searches and papers your agents read, with the text they got back, so the next agent reads the kept copy instead of fetching it again." },
  "result-part": { term: "Part", what: "The part of the project your agent filed these results under when it recorded them. Only changes to that part's files make a result stale." },
  // The Stats page, one entry for each count.
  "stat-shown": { term: "Past attempts shown", what: "Earlier attempts ANVC put in front of an agent: at a session start, after a failed command, or when it asked. Each counts once a session." },
  "stat-stopped": { term: "Commands stopped", what: "Commands ANVC stopped once because they failed in an earlier session. Your agent can run one again if something changed." },
  "stat-matched": { term: "Errors matched", what: "Failed commands whose error an earlier attempt had already hit. ANVC showed your agent that attempt." },
  "stat-recovered": { term: "Restored after compaction", what: "Times a session got its own earlier work back after its context was compacted." },
  "stat-rules": { term: "Writing rules given", what: "Times your agent got a rule set's text just before it wrote what the rules cover, such as a commit message." },
  "stat-asked": { term: "Lookups by your agent", what: "Times your agent searched ANVC or opened a record on its own." },
  "stat-avoided": { term: "Dead ends avoided", what: "An estimate. ANVC showed a dead end, and that session then recorded no new failure on the same files." },
  "stat-recorded": { term: "Attempts with a reason", what: "Attempts your agent recorded with a reason, kept or abandoned. The work log lists them." },
  "stat-autosaved": { term: "Attempts without a reason", what: "Work your agent didn't record, which ANVC saved from the raw log. The work log shows it under No reason." },
  "stat-absorbed": { term: "Goal and rule updates", what: "Updates a small model made to the goals and writing rules from your sessions, when that is on." },
  "stat-confirmed": { term: "Marked helpful", what: "Records your agent or you marked as helpful." },
  "stat-added": { term: "Tokens added to agents' context", what: "Everything ANVC gave your agents so far, estimated at 4 characters a token.", why: "For scale: one request from your agent in a long session sends about 300,000 tokens." },
  "stat-absorb-tokens": { term: "Tokens for goal updates", what: "What the small model used to update goals and writing rules, outside your sessions." },
  absorb: {
    term: "Goals, rules and map from your sessions",
    what: "After your agent's turns, at most every half hour, a small model reads what's new and updates the goals, writing rules and map. It runs through your claude or codex login, apart from your agent.",
    why: "The first update reads more: about 8,000 tokens with Claude Haiku. For scale, one request from your agent in a long session sends about 300,000.",
  },
  "project-map": {
    term: "Map",
    what: "The parts of your project and how they connect: drawn from your code's imports, with what each part is for from your agent's notes.",
  },
  "project-status": {
    term: "Status",
    what: "What each agent session is doing now, the work finished recently and whether it's committed, pushed or released, and what's queued next.",
    why: "Your agent is given this list when a session starts and again after its context is compacted. You can turn that off in Settings, under Your agent.",
  },
  "project-goals": {
    term: "Goals",
    what: "What the project is for, as goals and sub-goals, each To do, In progress, Done or Dropped. You and your agents can add and change them, and every change keeps who made it and why.",
    why: "Your agent is given the goals when a session starts, and links the work it records to the sub-goal it served.",
  },
  "project-rules": {
    term: "Writing rules",
    what: "Each rule set names a kind of text, such as commit messages or the files matching server/**/*.tsx, and where its rules are written, usually a heading in AGENTS.md.",
    why: "Your agent is given the list when a session starts, and a rule set's text right before it writes text the set covers.",
  },
  "project-tools": {
    term: "Tools",
    what: "The MCP servers, plugins, skills, commands and hooks each agent has, read from that agent's own config files, and whether each is on. ANVC never changes them.",
    why: "A note says when to use a tool. Your agents are given the notes when a session starts.",
  },
  authored: {
    term: "Agent-written",
    what: "The agent wrote this record itself, in its own words, when it finished the work.",
  },
  captured: {
    term: "Saved from the log",
    what: "Your agent didn't record this, so ANVC saved what the log saw: commands, files and what failed. Only the agent can say why.",
    why: "Ask your agent to use anvc_checkpoint and it will title its work and say why.",
  },
  anchor: {
    term: "Commit",
    what: "The commit the agent started from.",
  },
  continued: {
    term: "Retries",
    what: "This attempt retried an earlier one that was abandoned.",
  },
  output: {
    term: "Output",
    what: "What the failing command printed, word for word.",
    why: "Compare it with the agent's reason above.",
  },
  "ruled-out": {
    term: "Ruled out",
    what: "Other approaches the agent considered and set aside, each with its reason.",
  },
  "not-investigated": {
    term: "Not checked",
    what: "Questions the agent left open. Unlike ruled out, these might still work.",
  },
  recheck: {
    term: "Recheck command",
    what: "One command that shows whether this outcome still holds. Run it before trusting an old dead end.",
  },
  steps: {
    term: "Steps",
    what: "Every file read, file written and command run during the attempt, in order.",
  },
  private: {
    term: "Private",
    what: "Only on this computer. Never pushed.",
    why: "Your agent can still read it. To share one: anvc share <id>.",
  },
  shared: {
    term: "Shared",
    what: "Pushed with your code, with paths made relative and your prompts removed.",
  },
  shown: {
    term: "Shown",
    what: "Past attempts ANVC showed an agent without being asked.",
  },
  opened: {
    term: "Opened",
    what: "Past attempts an agent looked up itself.",
  },
  avoided: {
    term: "Avoided",
    what: "Dead ends an agent was shown and didn't repeat. This is an estimate.",
  },
  confirmed: {
    term: "Confirmed",
    what: "Past attempts an agent marked as helpful.",
  },
  "earlier-version": {
    term: "Earlier version",
    what: "What this part was described as before the current description replaced it.",
  },
};
