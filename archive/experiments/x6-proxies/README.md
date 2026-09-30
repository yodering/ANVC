# X6 — what the capture log already knows

Every other number here is either *delivery* — the record reached the agent —
or a single-turn plan on a hand-built case. Neither says anything about a real
project over weeks.

The capture log can, and nothing read it but `ingest`. No agent cooperation, so
nothing can be forgotten or gamed.

```bash
python3 proxies.py                                  # current repo
python3 proxies.py --repo /path/to/project
```

## What it measures, and why these four

| Proxy | The complaint it answers |
|---|---|
| **Re-read rate** — files a session read that an earlier session already read | Users built whole tools for this; "30+ touches against 1" is their stuck-loop signal |
| **Repeated failure** — same command failing across two sessions | The one thing a record of a dead end exists to prevent, and the one nobody logs |
| **Walked into a wall** — a file edited while an unresolved abandoned record names it | The most direct proxy available: the warning existed and the work happened anyway |
| **Session shape** — duration and distinct files | Capture answers this better than the record index, which dedupes paths and so cannot tell a file read once from one read twenty times |

## First run, on this repository

```
sessions 3 · events 3,846
sessions with real work 1 · too thin to time 2
reads: 78 distinct files, 1 already read by an earlier session (1.3%)
commands failing in more than one session: 0
edits to a file with an open dead end: 1
```

**The wall proxy fired on its first run**, and correctly: `experiments/x3-probe/probe.py`
was edited while an unresolved record named that file — the probe that was built
and then abandoned as ungradable. The warning existed; the edit happened anyway.

## What these numbers are not

Proxies, not outcomes. A re-read may be diligence rather than amnesia. A
repeated failure may be a genuinely flaky test. An edit to a warned file may be
the fix.

They earn their place because they move **without anyone being asked a
question** — which is the whole problem with the alternative. Measured across
thousands of reports about agent-memory tools: the costs are quantified to three
significant figures and the benefits are quantified nowhere, because measuring
benefit has always required someone to notice and report it.

## An honesty note about small n

The first version reported a median session length of **0.2 minutes**. Two
near-empty sessions — a probe and a crashed start — sat beside one session of
3,842 events, and the median landed between them. Technically correct, entirely
useless.

Sessions under 20 events are now set aside and *counted*, and the rest are
reported as shortest/median/longest rather than one number. With one real
session that shows as one number three times, which is the honest shape of the
data rather than a distribution that does not exist.
