# X3 — the probe that was built and not run

**Result: not run. The corpus cannot grade it, and a number from it would have
meant nothing.**

The plan was the cheap gate before any benchmark: take X2b's 51 stuck cases,
ask a model in one turn what it would try first, and compare three arms — no
record, a placebo record from an unrelated repository, and the record that
actually applies. No agent loop, no Docker, tens of dollars.

It does not survive contact with the data. Both gradable signals fail.

## Why

**The failing approach is generic.** `python|reproduce.py` accounts for 38 of
51 cases, and generic reproduce-or-edit steps for 41 of 51. Grading on whether
a plan proposes it would measure how common that phrase is, not avoidance —
and writing a reproduction script is the *correct* first move, which the
passing runs also make.

**The error is rarely specific.** Only 8 of 51 signatures name a symbol or
module you could check a plan against (`cannot import name 'Literal'`, `No
module named 'astarte.interfaces'`). The rest are bare `TypeError` (13),
`AssertionError` (5), `AttributeError` (4). A plan cannot be said to have
anticipated "a TypeError".

## What this says about the corpus, not the filter

X2b's filter is sound. Those agents were genuinely stuck — the same failure a
median of 9 times, 92% of everything that went wrong in the run, while a
sibling hit it and moved on.

But **being stuck re-running a reproduction script that keeps throwing
TypeError is an agent failing to debug, not a dead end a record describes.** A
note saying "reproduce.py threw TypeError" tells the next agent nothing it
would not learn from running one command.

The kind of failure this product records — *we tried approach X for goal G and
abandoned it because Y* — is a statement about a design decision. SWE-agent
trajectories on single-issue tasks mostly do not contain those. They contain
one agent, one bug, and a debugging loop.

## What would be needed instead

A corpus where attempts differ by **approach** rather than by luck: several
sessions on one codebase choosing different designs, where one is abandoned
for a reason that is not rediscoverable in a single command. ChainSWE and
SWE-Chain are the only public benchmarks with sequential dependency, and
neither was built to isolate that.

Failing that, the honest measurement is on a real repository over time — ours
— and it is slower and smaller than a benchmark run.

## Files

`probe.py` is complete and runnable: three arms, placebo drawn from the full
pool, mechanical grading, `--dry-run` to inspect prompts without calling
anything. `extract_issues.py` pulls issue text for all 51 cases. Both are kept
because the design is reusable the moment there is a corpus that can grade it.
