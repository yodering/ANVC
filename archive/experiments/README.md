# Early experiments

These are small experiments we ran while designing ANVC, kept so anyone can
see what they found and repeat them. They're small: tens to a few hundred
cases each, several on small, cheap models, run by one or two people. They
aren't benchmarks, and a number here doesn't hold beyond the setup it came
from.

Each folder has its own README with the question, the method, the result and
what wasn't checked.

| | question |
|---|---|
| [x0-retry-rate](x0-retry-rate/) | How often do agents retry something that already failed? |
| [x0b-triviality](x0b-triviality/) | Which of those retries are trivial? (script only) |
| [x1-cross-session](x1-cross-session/) | How often does a dead end from one task come back in another? |
| [x2-eligible](x2-eligible/) | Which cases are worth paying to test? |
| [x3-probe](x3-probe/) | The probe that was built and not run, and why |
| [x6-proxies](x6-proxies/) | What the capture log already knows |

Files that hold other projects' text, such as SWE-agent issue statements, are
left out of the public copy. The scripts beside them rebuild them.
