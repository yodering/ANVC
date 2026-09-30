# Results

ANVC also keeps track of the numbers a project relies on, like an accuracy in
a paper or a latency in a README. It's on unless you turn it off, with
`anvc data off` for one project or `anvc data off --everywhere` for all of
them.

An agent records a result with `anvc_result`: the value, where it lives (a
file and a key, such as `results/v6.json → test.acc`), what it depends on, and
why. ANVC reads the file to check the value, and takes the command, its
settings and its input files from the log of what the agent ran. A result is
draft, current, locked, superseded or invalid. Only you can lock one; an
agent's lock waits as a proposal on the Results page, or for
`anvc result lock <id>`. A newer result that replaces an older one supersedes
it, unless the older one is locked, and each result keeps its versions with
what changed between them.

Agents are told when a session starts which results need a look, such as a
locked one whose code changed since, and are shown a result when a prompt
mentions its number.

`anvc whence 88.1%` says where a number came from: recorded results holding
it, files a logged command wrote that hold it (a 0.8812 in a file matches
88.1%), and commands whose output printed it. `anvc check paper.tex` does that
for every number in a Markdown or LaTeX document and marks each one found,
changed since, unsure or not found. A number counts as found only if one run
printed it along with the other numbers in its sentence or table row, before
the document last changed. Anything less is unsure, and each unsure number
shows the print that might be it. A number worked out by hand comes out not
found; ask your agent to record it as a result, with what it was computed
from.

The hooks only see what agents run. Start a run yourself with
`anvc run -- python train.py --out results/v6.json` and it's logged the same
way, so its numbers can be traced too.
