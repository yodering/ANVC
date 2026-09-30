#!/usr/bin/env python3
"""
X3: does handing over a dead end change what the agent tries next?

The cheap gate before any benchmark. A full run needs roughly 1,500 instances
per arm because most instances never exercise memory at all; X2b filtered to
51 cases where an agent hit one wall a median of nine times, never got past
it, and a sibling attempt hit that same wall and moved on. Those are the cases
where a record has an obvious job.

This asks one question per case, in one turn, with no agent loop, no Docker
and no patch evaluation: given the issue, what are the first three things you
would try? Then: does the plan avoid the wall the stuck run died on?

Three arms, because two would not be honest:

    none      the issue alone
    placebo   the issue plus a dead end from a DIFFERENT repository, in the
              same format and roughly the same length
    record    the issue plus the dead end that actually applies

Without the placebo a positive result only shows that adding text changes
output, which is already known. The placebo also catches the opposite failure:
if it scores like the record, the effect is the shape of the block rather than
its content.

Grading is deliberately mechanical. The model is asked to end with a verdict
line naming whether its plan runs the command that failed, and separately a
regex checks whether the failing approach appears in the plan at all. Neither
is a claim about understanding — a model that writes "I checked the record" is
producing text only weakly coupled to what drove its output. What the regex
sees is the plan itself.

    python3 probe.py --cases ../x2-eligible/stuck.jsonl --limit 5 --dry-run
    python3 probe.py --cases ../x2-eligible/stuck.jsonl --limit 51

Set OPENAI_API_KEY. `--dry-run` prints the prompts and calls nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

MODEL = "gpt-4o-mini"
ENDPOINT = "https://api.openai.com/v1/chat/completions"

ASK = """You are about to start work on this issue in a Python repository.

{issue}

List the first three things you would try, as three short numbered lines.
Then, on a final line, write exactly one of:

VERDICT: WOULD RUN <command>   — if your plan runs a specific command early
VERDICT: NO COMMAND            — if none of your three steps runs a command

Be concrete. Name real commands and files."""

WITH_RECORD = """{ask}

A previous attempt on this repository recorded the following, and it is
available to you:

Attempts recorded in this repository that were abandoned and not resolved:
- {goal} — {signature}"""


def call(prompt: str, key: str) -> str:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 400,
    }).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]


def mentions(plan: str, approach: str) -> bool:
    """Whether the plan proposes the approach that failed.

    `approach` is X0's normalised form, verb plus file-like operands, e.g.
    `python|reproduce.py`. Both halves have to appear for a match, so a plan
    that merely mentions Python does not count.
    """
    parts = [p for p in re.split(r"[|,]", approach) if p.strip()]
    if not parts:
        return False
    text = plan.lower()
    return all(re.search(re.escape(p.strip().lower()), text) for p in parts)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", required=True)
    ap.add_argument("--issues", default=None, help="jsonl of {instance_id, issue}")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    cases = [json.loads(l) for l in open(args.cases)]
    issues: dict[str, str] = {}
    if args.issues:
        for line in open(args.issues):
            row = json.loads(line)
            issues[row["instance_id"]] = row["issue"]

    # The placebo is drawn from every case, not from the truncated run, so a
    # small --limit still has somewhere to draw an unrelated dead end from.
    pool = [c for c in cases if c["instance_id"] in issues]
    cases = pool[: args.limit]
    if not cases:
        print("no cases with issue text; run extract_issues.py first", file=sys.stderr)
        return 2

    key = os.environ.get("OPENAI_API_KEY", "")
    if not key and not args.dry_run:
        print("OPENAI_API_KEY not set", file=sys.stderr)
        return 2

    rng = random.Random(0)
    results = []
    for i, case in enumerate(cases, 1):
        issue = issues[case["instance_id"]][:6000]
        ask = ASK.format(issue=issue)
        # A dead end from a different repository, same shape and similar
        # length: the control for "any extra text changes the answer".
        other = rng.choice([c for c in pool if c["instance_id"] != case["instance_id"]])
        arms = {
            "none": ask,
            "placebo": WITH_RECORD.format(ask=ask, goal=other["approach"], signature=other["signature"]),
            "record": WITH_RECORD.format(ask=ask, goal=case["approach"], signature=case["signature"]),
        }

        if args.dry_run:
            print("=" * 72)
            print(case["instance_id"], "| failing approach:", case["approach"])
            print("-" * 72)
            print(arms["record"][-700:])
            continue

        row = {"instance_id": case["instance_id"], "approach": case["approach"]}
        for arm, prompt in arms.items():
            try:
                plan = call(prompt, key)
            except urllib.error.HTTPError as e:
                print(f"  {case['instance_id']} {arm}: HTTP {e.code} {e.read()[:200]!r}", file=sys.stderr)
                return 1
            row[arm] = {"repeats_failed_approach": mentions(plan, case["approach"]), "plan": plan}
        results.append(row)
        flags = " ".join(f"{a}={'Y' if row[a]['repeats_failed_approach'] else 'n'}" for a in arms)
        print(f"[{i}/{len(cases)}] {case['instance_id'][:44]:<44} {flags}", file=sys.stderr)

    if args.dry_run:
        return 0

    out = Path(__file__).resolve().parent / "results.jsonl"
    with out.open("w") as fh:
        for r in results:
            fh.write(json.dumps(r) + "\n")

    print(json.dumps({
        "model": MODEL,
        "cases": len(results),
        "proposed_the_failing_approach": {
            arm: sum(1 for r in results if r[arm]["repeats_failed_approach"])
            for arm in ("none", "placebo", "record")
        },
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
