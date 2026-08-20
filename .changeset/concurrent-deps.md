---
'@theoven/core': patch
---

A route's declared dependencies now resolve concurrently.

Three dependencies each doing 10 ms of I/O cost ~11 ms instead of ~33 ms — a route waits for the
slowest, not the sum. Sub-dependencies are still ordered by what needs what.

A failure is reported in **declaration order** rather than by whichever rejected first, so the same
bug does not produce different errors on different runs. Siblings are still torn down.

Costs ~400 ns on routes declaring more than one dependency; routes with one are unchanged.
