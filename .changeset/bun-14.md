---
'@theoven/core': patch
---

Require Bun 1.4 or newer across every package.

Nothing in core changed; the whole suite passes unchanged on the new runtime. The bump is so
packages can use APIs that arrived in 1.4 — `Bun.Image` first — rather than feature-detecting
around them forever, and is cheap to take now while the framework is pre-1.0.
