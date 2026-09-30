#!/usr/bin/env python3
"""
X2: how many cases are worth paying to test?

The experiment everyone reaches for is "run a benchmark with memory and
without, compare resolve rate". On SWE-bench-shaped work that needs on the
order of 1,500 instances per arm to see a few points, because most instances
never exercise memory at all — you are paying to run the 78% where nothing
could possibly happen, to find a small difference in the 22% where it could.

So filter first. A case is worth running only if:

  1. An earlier attempt hit a failure and got past it.
  2. A later, independent attempt hit the *same* failure.
  3. The later attempt died there.

That is a case where a record written by the first attempt is exactly the
thing the second one needed, and its absence is visible in the outcome. If
almost no such cases exist, no injection strategy can help and there is
nothing to buy.

Deliberately conservative, reusing X0's detector so the failure signatures are
the same instrument that produced its 26.1%:

  - Navigation is not an approach; `ls` and `grep` never count.
  - The failure signature must match exactly after normalisation.
  - The earlier attempt must have RECOVERED — a sibling that also died there
    knew nothing worth passing on.
  - Harness noise and untransferable failures (typos, usage text, missing
    files) are excluded, because "someone once mistyped `cd..`" is not a
    record worth writing.

Usage:  python3 filter.py shard0.parquet [shard4.parquet ...]
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "x1-cross-session"))
from measure import NOT_TRANSFERABLE, TOOL_FIGHT, steps  # noqa: E402

import pyarrow.parquet as pq  # noqa: E402


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: filter.py <shard.parquet>...", file=sys.stderr)
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

    eligible: list[dict] = []
    scanned = 0

    for instance, attempts in by_instance.items():
        # Hold the model fixed: an instance where one model passed and a weaker
        # one failed says something about the models, not about what a record
        # could have carried.
        by_model: dict[str, list[dict]] = defaultdict(list)
        for a in attempts:
            by_model[a["model_name"]].append(a)

        for model, group in by_model.items():
            outcomes = {bool(a["target"]) for a in group}
            if len(outcomes) < 2:
                continue
            scanned += 1

            walked = [(a, steps(a["trajectory"])) for a in group]

            # What a passing attempt hit and still got past. Only these carry
            # advice: a sibling that also died there had nothing to offer.
            survived: set[tuple[str, str]] = set()
            for attempt, path in walked:
                if attempt["target"]:
                    survived.update(path)

            for attempt, path in walked:
                if attempt["target"] or not path:
                    continue
                # Where this attempt ended. Earlier failures it recovered from
                # itself are not what killed it.
                act, sig = path[-1]
                if TOOL_FIGHT.search(sig) or NOT_TRANSFERABLE.search(sig):
                    continue
                if (act, sig) not in survived:
                    continue
                eligible.append({
                    "instance_id": instance,
                    "model": model,
                    "approach": act,
                    "signature": sig[:200],
                    "attempts_at_instance": len(group),
                })

    # One case per instance: several failed attempts hitting the same wall is
    # one thing to test, not many, and counting them separately would inflate
    # the sample the way X0's first run did.
    per_instance: dict[str, dict] = {}
    for case in eligible:
        per_instance.setdefault(case["instance_id"], case)

    print(json.dumps({
        "instances_with_mixed_outcomes_same_model": scanned,
        "eligible_failed_attempts": len(eligible),
        "eligible_instances": len(per_instance),
    }, indent=2))

    out = Path(__file__).resolve().parent / "eligible.jsonl"
    with out.open("w") as fh:
        for case in per_instance.values():
            fh.write(json.dumps(case) + "\n")
    print(f"\nwrote {len(per_instance)} cases to {out.name}", file=sys.stderr)

    for case in list(per_instance.values())[:8]:
        print(f"  {case['instance_id']:<42} {case['approach'][:26]:<26} {case['signature'][:60]}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
