# laplace-jupiter

## 1.0.9

### Patch Changes

- e84c6d6: Build and publish the Docker image inline from the Release workflow when a new tag is created. Tags pushed by `GITHUB_TOKEN` from inside another workflow do not fire downstream `push` events, so the Docker workflow was being skipped for `v*` tags created by Changesets.

## 1.0.8

### Patch Changes

- 80ca28a: Verify Docker-only release pipeline end-to-end via Changesets `privatePackages.tag`.

## 1.0.7

### Patch Changes

- abfc812: update release process
