---
"laplace-jupiter": patch
---

Build and publish the Docker image inline from the Release workflow when a new tag is created. Tags pushed by `GITHUB_TOKEN` from inside another workflow do not fire downstream `push` events, so the Docker workflow was being skipped for `v*` tags created by Changesets.
