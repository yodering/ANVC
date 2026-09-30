# X1 — cross-task dead ends

Answers: does a dead end recur on a **different task in the same repository**?

**Result: 22.2% of tasks, 15.8% excluding the largest contributing repo.**
Full writeup and limits: `docs/results/x1-cross-task-2026-09-20.md`.

X0 recorded this as unmeasurable with this corpus. It is not — X0's own
sampler discarded the data that answers it, keeping one trajectory per instance
while the dataset stores up to 98 independent attempts of each.

## Reproduce

```bash
# Same shards as X0. The rows API returns contiguous blocks of one instance,
# which is exactly the structure this experiment needs and X0 had to defeat.
for i in 0 4 8; do
  curl -sL "https://huggingface.co/api/datasets/nebius/SWE-agent-trajectories/parquet/default/train/$i.parquet" -o shard$i.parquet
done

python3 measure.py shard0.parquet shard4.parquet shard8.parquet
```

Imports the X0 detector directly from `../x0-retry-rate/extract.py`, so the
failure signatures are the same instrument that produced X0's 26.1%.

Takes a few minutes: it parses every attempt rather than one per instance.

## Reading the output

Two numbers matter and one is a trap.

- `cross_task_same_repo.share` — the headline, the production question.
- `largest_single_repo_share_of_hits` — **check this first.** The first run of
  this experiment looked like a 24% result that was one repository. If this is
  high, the headline is that repo's quirks.
- `share_strategic` — same-instance siblings, the easier case. Report
  separately; it is an upper bound on an identical task, not the product claim.

`share_all` includes the agent fighting its own editor. Never quote it.
