# X2 — which cases are worth paying to test?

**Result: 109 cases across 94 repositories, at zero inference cost.**

The experiment everyone reaches for is "run a benchmark with memory and
without, compare resolve rate". That needs roughly 1,500 instances per arm to
see a few points, because most instances never exercise memory at all — you
pay to run the ~78% where nothing could happen, to find a small difference in
the rest.

So filter first. A case is worth running only when:

1. An earlier attempt hit a failure and got past it.
2. A later, independent attempt hit the same failure.
3. The later attempt died there.

That is precisely where a record written by the first attempt is the thing the
second one needed, and its absence shows up in the outcome.

## Result

| | |
|---|---|
| Instances with mixed outcomes, same model | 267 |
| Eligible failed attempts | 772 |
| **Eligible cases** (one per instance) | **109** |
| Repositories represented | 94 |
| Largest single repository | 11 cases (10%) |

Failure kinds: TypeError 23, AttributeError 16, ImportError 11,
ModuleNotFoundError 9, ValueError 8, assorted test failures 12, other 30.

Not concentrated: X1's cross-task figure leaned 39% on one repository, and
this does not — the largest contributor is a tenth of the sample.

## Why this is cheap

Three parquet shards and the X0 detector. No inference, no Docker, no patches.
The filtering itself is the saving: the probe that comes next runs on 109
pre-qualified cases instead of a benchmark's worth of mostly-irrelevant ones.

## Reproduce

```bash
for i in 0 4 8; do
  curl -sL "https://huggingface.co/api/datasets/nebius/SWE-agent-trajectories/parquet/default/train/$i.parquet" -o shard$i.parquet
done
python3 filter.py shard0.parquet shard4.parquet shard8.parquet
```

Writes `eligible.jsonl`: instance id, the approach that failed, the failure
signature, and how many attempts that instance had.

## What this does and does not establish

**Does:** there are enough cases where a record could have mattered to run a
measurement on, and they are spread across many repositories.

**Does not:** that a record changes anything. Every case here is one where the
information existed and did not reach the second agent — the size of the
opportunity, not evidence of the fix.

---

# X2b — the stricter filter, and why X2 was not enough

**Result: 51 cases across 43 repositories.**

X2's 109 cases were too loose, and measuring them said so: in those instances
failing runs hit a median of **2** distinct failures and passing runs **1**. A
failing run was not characterised by one specific wall — it was slightly worse
everywhere — so the shared failure was often incidental rather than decisive.
A record about it would not obviously have changed the outcome, and a probe
built on that sample would have measured very little.

So ask the stricter question a record can actually answer: **did the agent hit
the same wall repeatedly and never get past it, while a sibling hit that same
wall and moved on?**

| | |
|---|---|
| Stuck attempts | 129 |
| **Stuck cases** (one per instance) | **51** |
| Repositories | 43 |
| Largest single repository | 8 cases (16%) |
| Repeats of the same failure | median **9**, max **53** |
| That failure's share of the run's failures | median **92%** |
| Cases with 10+ repeats | 25 |

The strongest cases are unambiguous:

```
53x  98% of run   pydantic-1755      TypeError: __new__() missing N required positional args
49x 100% of run   pydantic-6194      ImportError: cannot import name 'Literal' from 'typing'
47x  96% of run   pygame-menu-357    AssertionError: pygame is not initialized
47x  92% of run   ciprs-reader-38    TypeError: string indices must be integers
```

An agent hitting one wall 53 times, with 98% of its failures being that wall,
while a sibling attempt hit the same wall and carried on, is a run stuck on one
thing. That is the case a record is for.

## Reproduce

```bash
python3 stuck.py shard0.parquet shard4.parquet shard8.parquet --min-repeats 3
```

Writes `stuck.jsonl` with the repeat count and what share of the run's
failures it accounted for.

## Still not evidence

Every case here is one where the information existed in a sibling run and did
not reach this one. That sizes the opportunity precisely; it does not show
that handing over a record changes the outcome. What it does buy is a sample
small enough to measure on — 51 pre-qualified cases rather than a benchmark's
worth of instances where nothing could happen either way.
