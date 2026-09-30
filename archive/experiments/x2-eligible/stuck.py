#!/usr/bin/env python3
"""
X2b: cases where an agent was genuinely stuck on one wall.

X2's filter found 109 cases where a failing attempt died on a failure some
sibling had survived. That is too loose, and measuring it said so: failing
runs hit a median of 2 distinct failures and passing runs 1. A failing run is
not characterised by one specific wall — it is slightly worse everywhere — so
the shared failure is often incidental rather than decisive, and a record
about it would not obviously have changed the outcome.

This asks the stricter question a record can actually answer:

    Did the agent hit the SAME failure REPEATEDLY and never get past it,
    while a sibling attempt hit that same failure and moved on?

That is a run stuck on one thing, not a run going badly everywhere. A record
written by the sibling has an obvious job there: the thing you are about to
bang your head against is survivable, and here is the attempt that survived it.

Three conditions, all stricter than X2:

  1. The failure repeats — the agent hit it at least `--min-repeats` times
     (default 3) and never recovered from it afterwards.
  2. A sibling survived that exact failure and passed.
  3. The stuck run is not simply worse everywhere: its repeats of THIS failure
     must be a real share of its total failures (default half), so a run that
     hit twenty different walls does not qualify on one of them.

Usage:  python3 stuck.py shard0.parquet [...] [--min-repeats 3]
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "x1-cross-session"))
from measure import NOT_TRANSFERABLE, TOOL_FIGHT, steps  # noqa: E402

import pyarrow.parquet as pq  # noqa: E402


def main(argv: list[str]) -> int:
    shards = [a for a in argv if not a.startswith("--")]
    if not shards:
        print("usage: stuck.py <shard.parquet>... [--min-repeats N]", file=sys.stderr)
        return 2
    min_repeats = 3
    if "--min-repeats" in argv:
        min_repeats = int(argv[argv.index("--min-repeats") + 1])

    by_instance: dict[str, list[dict]] = defaultdict(list)
    for path in shards:
        parquet = pq.ParquetFile(path)
        for batch in parquet.iter_batches(
            batch_size=200,
            columns=["instance_id", "model_name", "target", "trajectory"],
        ):
            for row in batch.to_pylist():
                by_instance[row["instance_id"]].append(row)

    cases: list[dict] = []
    for instance, attempts in by_instance.items():
        by_model: dict[str, list[dict]] = defaultdict(list)
        for a in attempts:
            by_model[a["model_name"]].append(a)

        for model, group in by_model.items():
            if len({bool(a["target"]) for a in group}) < 2:
                continue
            walked = [(a, steps(a["trajectory"])) for a in group]

            # Failures a PASSING sibling hit and still got past.
            survived: set[tuple[str, str]] = set()
            for attempt, path in walked:
                if attempt["target"]:
                    survived.update(path)

            for attempt, path in walked:
                if attempt["target"] or not path:
                    continue
                counts = Counter(path)
                total = len(path)
                for (act, sig), repeats in counts.items():
                    if repeats < min_repeats:
                        continue
                    if TOOL_FIGHT.search(sig) or NOT_TRANSFERABLE.search(sig):
                        continue
                    if (act, sig) not in survived:
                        continue
                    # Never got past it: the last failure of the run is this one.
                    if path[-1] != (act, sig):
                        continue
                    # And it dominates this run's failures, so a run that hit
                    # twenty different walls does not qualify on one of them.
                    if repeats / total < 0.5:
                        continue
                    cases.append({
                        "instance_id": instance,
                        "model": model,
                        "approach": act,
                        "signature": sig[:200],
                        "repeats": repeats,
                        "total_failures_in_run": total,
                        "share": round(repeats / total, 2),
                    })

    # One case per instance, strongest first.
    best: dict[str, dict] = {}
    for c in sorted(cases, key=lambda c: -c["repeats"]):
        best.setdefault(c["instance_id"], c)

    repos = {c["instance_id"].rsplit("-", 1)[0] for c in best.values()}
    print(json.dumps({
        "min_repeats": min_repeats,
        "stuck_attempts": len(cases),
        "stuck_instances": len(best),
        "repositories": len(repos),
    }, indent=2))

    out = Path(__file__).resolve().parent / "stuck.jsonl"
    with out.open("w") as fh:
        for c in best.values():
            fh.write(json.dumps(c) + "\n")
    print(f"\nwrote {len(best)} cases to {out.name}", file=sys.stderr)
    for c in list(best.values())[:10]:
        print(f"  x{c['repeats']:<3} ({c['share']:.0%} of run)  {c['instance_id'][:40]:<40} {c['signature'][:52]}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
