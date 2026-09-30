#!/usr/bin/env python3
"""Pull the issue statement for each stuck case out of the trajectories.

The first `user` message of any attempt carries the issue text SWE-agent was
given. Every attempt at an instance starts from the same one, so the first is
as good as any.
"""
import json, sys, re
from pathlib import Path
import pyarrow.parquet as pq

cases = {json.loads(l)["instance_id"] for l in open(sys.argv[1])}
found = {}
for shard in sys.argv[2:]:
    for b in pq.ParquetFile(shard).iter_batches(batch_size=200, columns=["instance_id", "trajectory"]):
        for r in b.to_pylist():
            iid = r["instance_id"]
            if iid not in cases or iid in found:
                continue
            for m in r["trajectory"] or []:
                if m.get("role") != "user":
                    continue
                text = m.get("text") or ""
                if "issue text" not in text.lower():
                    continue
                # Drop SWE-agent's own tool preamble: it describes the harness,
                # not the problem, and would dominate the prompt.
                cut = re.split(r"\n\s*(INSTRUCTIONS:|\(Open file:)", text)[0]
                found[iid] = cut.strip()
                break
out = Path(__file__).resolve().parent / "issues.jsonl"
with out.open("w") as fh:
    for iid, issue in found.items():
        fh.write(json.dumps({"instance_id": iid, "issue": issue}) + "\n")
print(f"{len(found)} of {len(cases)} cases have issue text -> {out.name}")
