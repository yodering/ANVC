# X0 — retry rate

Answers: how often does an agent retry an approach that already failed?

**Result: 26.1% strategic, 42.0% including tool-fighting** (877 distinct
instances). Full writeup and limits:
`docs/results/x0-retry-rate-2026-09-17.md`.

## Reproduce

```bash
# Parquet shards, not the rows API — the API returns ~20 attempts of the same
# instance in contiguous blocks, which silently turns 400 rows into 39 problems.
for i in 0 4 8; do
  curl -sL "https://huggingface.co/api/datasets/nebius/SWE-agent-trajectories/parquet/default/train/$i.parquet" -o shard$i.parquet
done

python3 sample.py shard0.parquet shard4.parquet shard8.parquet > one-per-instance.jsonl
python3 extract.py one-per-instance.jsonl
```

`nebius/SWE-agent-trajectories` is CC-BY-4.0. Two more corpora are available
and unmeasured: `nebius/SWE-rebench-openhands-trajectories` (CC-BY-4.0, 67k)
and `SWE-bench/SWE-smith-trajectories` (MIT, 76k).
