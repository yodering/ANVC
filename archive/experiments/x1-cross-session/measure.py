#!/usr/bin/env python3
"""
X1: how much of what an agent fails on has a sibling already solved?

X0 answered how often one agent repeats its *own* failed approach: 26.1%. It
also recorded, as its main limit, that the stronger question needs "sessions
linked by repository, which this corpus does not provide."

That was wrong, and X0's own sampler is the reason. The dataset stores up to 98
independent attempts per instance, and X0 kept exactly one of each to avoid
counting the same problem twice. Those discarded siblings are the experiment:
they share an identical system prompt and diverge immediately after, so they
are separate sessions working the same task with no knowledge of each other —
which is precisely the situation ANVC claims to fix.

So this asks an observational question, with no inference spend and nothing
injected:

    When an attempt hits a failure and does not recover, had a sibling attempt
    at the same instance already hit that same failure and gone on to pass?

That failure is *knowable*. A record written by the sibling would have carried
it. It is the ceiling on what this product can save — not a measure of what it
does save, which needs the controlled run this does not attempt.

Deliberately conservative, in the same spirit as X0:

  - Only instances where a single model produced both outcomes are used, so
    task difficulty and model capability are held fixed.
  - A failure counts only if the signature matches exactly, after the same
    normalisation X0 uses (line numbers, addresses, temp paths, timings).
  - The sibling must have *recovered*: hit the failure and still passed. A
    sibling that also died there knew nothing worth passing on.
  - Failures in the last step are skipped. A run that ends for other reasons
    cannot be said to have died on the thing it last printed.

Usage:  python3 measure.py shard0.parquet [shard4.parquet ...]
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "x0-retry-rate"))
from extract import approach, commands, failed, signature  # noqa: E402

import pyarrow.parquet as pq  # noqa: E402
import re  # noqa: E402

# The harness rejecting its own edit command, not the codebase saying no. X0
# separated these and declined to claim them, because a better editor fixes
# them and a record of abandoned work does not. Counting them here would
# inflate the result with the one category already ruled out of scope.
TOOL_FIGHT = re.compile(
    r"Your (?:proposed )?edit has introduced"
    r"|^Usage: edit"
    r"|No file open"
    r"|Invalid line (?:number|range)"
    r"|Your command ran successfully and did not produce any output",
    re.IGNORECASE | re.MULTILINE,
)

# Failures that carry nothing a record could usefully pass on. Found by reading
# the first cross-task output rather than trusting the count: it was 24.3%
# until these were removed, and most of that was the agent mistyping a command.
#
#   find.: command not found      — a missing space, not a dead end
#   cd..: command not found       — the same
#   usage: dvc [-q | -v] ...      — a CLI printing its own help
#   File 'x.py' already exists    — the agent's own earlier step, not the repo
#
# A record saying "someone once typed `cd..`" is noise, and counting it would
# have inflated the one number this experiment exists to produce.
NOT_TRANSFERABLE = re.compile(
    r"command not found"
    r"|^usage: "
    r"|already exists"
    r"|No such file or directory"
    r"|invalid syntax \(<string>",
    re.IGNORECASE | re.MULTILINE,
)


def steps(trajectory: list[dict]) -> list[tuple[str, str]]:
    """(approach, failure signature) for every action with a known outcome.

    Mirrors X0's scan: an assistant message ends with a command, and the next
    message is its output. Navigation is dropped by `approach` returning None,
    so an agent groping around after a failure never registers as an attempt.
    """
    out: list[tuple[str, str]] = []
    messages = trajectory or []
    for i, message in enumerate(messages):
        if message.get("role") not in ("ai", "assistant"):
            continue
        issued = commands(message.get("text") or message.get("content") or "")
        if not issued:
            continue
        if i + 1 >= len(messages):
            continue  # no observation: outcome unknown, so it is not counted
        observation = messages[i + 1].get("text") or messages[i + 1].get("content") or ""
        if not failed(observation):
            continue
        act = approach(issued[-1])
        if act is None:
            continue  # navigation, which is not an approach to anything
        out.append((act, signature(observation)))
    return out


def cross_task(by_instance: dict[str, list[dict]]) -> dict:
    """The production question: does a dead end recur on a *different* task in
    the same repository?

    Same-instance overlap is the easy case and not what the product claims.
    ANVC's pitch is that records ride inside a repository, so an agent working
    task B benefits from what an agent abandoned on task A. Nobody has
    published this number — X0 recorded it as unmeasured and as the number that
    would justify the product most.

    A repeat counts only when the approach and the failure signature both match
    across two *different* instances, so a generic "file not found" shared by
    every task is not evidence of anything transferable.
    """
    by_repo: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    for instance, attempts in by_instance.items():
        repo = instance.rsplit("-", 1)[0]
        for attempt in attempts:
            for act, sig in steps(attempt["trajectory"]):
                if TOOL_FIGHT.search(sig) or NOT_TRANSFERABLE.search(sig):
                    continue
                by_repo[repo][instance].add((act, sig))

    shared = Counter()
    per_repo = Counter()
    examples: list[str] = []
    for repo, tasks in by_repo.items():
        if len(tasks) < 2:
            continue
        shared["repos"] += 1
        seen_before: set = set()
        for instance in sorted(tasks):
            here = tasks[instance]
            shared["tasks"] += 1
            overlap = here & seen_before
            if overlap:
                shared["tasks_hitting_an_earlier_task_dead_end"] += 1
                per_repo[repo] += 1
                if len(examples) < 10:
                    act, sig = sorted(overlap)[0]
                    examples.append(f"{repo}  {instance}  {act}  |  {sig[:80]}")
            seen_before |= here

    hits = shared["tasks_hitting_an_earlier_task_dead_end"]
    top = per_repo.most_common(1)[0] if per_repo else ("", 0)
    return {
        "repos_with_multiple_tasks": shared["repos"],
        "tasks_examined": shared["tasks"],
        "tasks_repeating_an_earlier_task_dead_end": hits,
        "share": round(hits / shared["tasks"], 4) if shared["tasks"] else None,
        # Reported because the first run of this looked like a 24% result and
        # was one repository: 10 of 14 hits came from `iterative__dvc`, which
        # also held a quarter of the tasks. A rate that rests on one repo is
        # that repo's quirks, not a rate. If this share is high, the headline
        # number means nothing.
        "repos_contributing_a_hit": len(per_repo),
        "largest_single_repo_share_of_hits": round(top[1] / hits, 3) if hits else None,
        "_examples": examples,
    }


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2

    by_instance: dict[str, list[dict]] = defaultdict(list)
    for path in argv:
        parquet = pq.ParquetFile(path)
        for batch in parquet.iter_batches(
            batch_size=200,
            columns=["instance_id", "model_name", "target", "trajectory"],
        ):
            for row in batch.to_pylist():
                by_instance[row["instance_id"]].append(row)

    # Hold the model fixed. An instance where one model passed and a weaker one
    # failed says something about the models, not about what was knowable.
    usable: dict[str, list[dict]] = {}
    for instance, attempts in by_instance.items():
        by_model: dict[str, set] = defaultdict(set)
        for a in attempts:
            by_model[a["model_name"]].add(bool(a["target"]))
        for model, outcomes in by_model.items():
            if len(outcomes) > 1:
                usable[instance] = [a for a in attempts if a["model_name"] == model]
                break

    stats = Counter()
    knowable_examples: list[str] = []

    for instance, attempts in usable.items():
        stats["instances"] += 1
        parsed = [(a, steps(a["trajectory"])) for a in attempts]

        # What a sibling that PASSED hit and survived. Only these carry advice:
        # a sibling that died on the same thing had nothing to offer.
        recovered: set[tuple[str, str]] = set()
        for attempt, walked in parsed:
            if attempt["target"]:
                recovered.update(walked)

        for attempt, walked in parsed:
            if attempt["target"] or not walked:
                continue
            stats["failed_attempts"] += 1
            # Where this attempt ended. The last failure is the one it did not
            # get past; earlier ones it recovered from itself.
            terminal = walked[-1]
            if terminal in recovered:
                stats["died_on_a_solved_failure"] += 1
                if TOOL_FIGHT.search(terminal[1]):
                    stats["tool_fighting"] += 1
                else:
                    stats["strategic"] += 1
                    if len(knowable_examples) < 12:
                        knowable_examples.append(f"{instance}  {terminal[0]}  |  {terminal[1][:90]}")

    total = stats["failed_attempts"]
    hit = stats["died_on_a_solved_failure"]
    strategic = stats["strategic"]
    print(json.dumps({
        "instances_with_mixed_outcomes_same_model": stats["instances"],
        "failed_attempts_examined": total,
        "died_on_a_failure_a_sibling_survived": hit,
        "share_all": round(hit / total, 4) if total else None,
        # The only number worth claiming. The rest is the agent losing a fight
        # with its own editor, which a record of abandoned work cannot help.
        "strategic": strategic,
        "share_strategic": round(strategic / total, 4) if total else None,
        "tool_fighting": stats["tool_fighting"],
    }, indent=2))

    if knowable_examples:
        print("\nExamples of a failure that was already knowable:", file=sys.stderr)
        for line in knowable_examples:
            print(f"  {line}", file=sys.stderr)

    # The production question, and the one X0 left open.
    across = cross_task(by_instance)
    examples = across.pop("_examples")
    print("\n" + json.dumps({"cross_task_same_repo": across}, indent=2))
    if examples:
        print("\nDead ends that recurred on a different task in the same repo:", file=sys.stderr)
        for line in examples:
            print(f"  {line}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
