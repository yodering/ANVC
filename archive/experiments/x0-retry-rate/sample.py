#!/usr/bin/env python3
"""One trajectory per distinct instance, from parquet shards.

The dataset stores roughly 20 attempts per instance in contiguous blocks, so
any offset-based sampling returns the same handful of problems over and over —
the first run of this experiment reported 400 rows that were really 39
problems. Deduplicating by `instance_id` is the whole point of this script.
"""
import json
import sys

import pyarrow.parquet as pq

seen: set[str] = set()
for path in sys.argv[1:]:
    parquet = pq.ParquetFile(path)
    for batch in parquet.iter_batches(
        batch_size=200, columns=["instance_id", "trajectory", "exit_status"]
    ):
        for row in batch.to_pylist():
            iid = row.get("instance_id")
            if iid in seen:
                continue
            seen.add(iid)
            print(json.dumps(row))
print(f"{len(seen)} distinct instances", file=sys.stderr)
