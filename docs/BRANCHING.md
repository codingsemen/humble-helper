# Branching and change conventions

Humble Helper uses short-lived topic branches targeting `main`; configure branch protection as described in [publish.md](../publish.md). Do not develop directly on `main` and do not keep long-running release branches.

## Branch names

Use a lowercase kebab-case description after one of these prefixes:

| Prefix | Use | Example |
| --- | --- | --- |
| `feature/` | User-visible behavior | `feature/bundle-expiry-filter` |
| `fix/` | Bug fix | `fix/steam-dlc-matching` |
| `security/` | Security or privacy fix | `security/restrict-message-senders` |
| `refactor/` | Internal behavior-preserving cleanup | `refactor/storage-queue` |
| `test/` | Test-only change | `test/donation-rounding` |
| `docs/` | Documentation-only change | `docs/store-publishing` |
| `ci/` | Pipeline or automation change | `ci/weekly-audit` |
| `chore/` | Maintenance not covered above | `chore/update-icons` |

Dependabot's generated branch names are exempt. A branch should address one cohesive change and should normally be deleted after it is merged.

## Normal workflow

1. Update `main` and create a topic branch:

   ```bash
   git switch main
   git pull --ff-only
   git switch -c feature/short-description
   ```

2. Commit focused changes. Conventional Commit subjects are preferred:

   - `feat: ...`
   - `fix: ...`
   - `security: ...`
   - `refactor: ...`
   - `test: ...`
   - `docs: ...`
   - `ci: ...`
   - `chore: ...`

3. Push the branch and open a pull request against `main`.
4. Rebase or fast-forward the branch onto current `main` before merge so the tested branch head includes the current integration point.
5. Add an appropriate release-note label such as `feature`, `fix`, `security`, `dependencies`, or `documentation`. Use `skip-changelog` only for changes users should not see in release notes.
6. Wait for `CI / Branch checks`, review the diff, and squash-merge. The squash title should remain a useful changelog entry.
7. Delete the topic branch.

## What CI tests

Pull-request CI explicitly checks out `github.event.pull_request.head.sha`. It therefore tests the exact commit at the tip of the topic branch, not GitHub's synthetic merge commit and not whatever currently happens to be on `main`.

CI runs automatically for pull requests targeting `main`, for pushes to `main`, and on manual request. It does not run twice for every push to an open pull request. Store credentials are never available to this workflow.

## Releases

Releases are made from `main` with immutable tags in the form `vMAJOR.MINOR.PATCH`. As a guide:

- The pipeline increments `PATCH` automatically after successful main CI when Firefox publishing is enabled and shipped extension content changed since the last release. Listing-only changes update AMO separately; pipeline, documentation, and test-only changes do not create extension versions.
- Increment `MINOR` for compatible features.
- Increment `MAJOR` for breaking behavior or data changes.

Keep the versions in `package.json` and `manifest.json` aligned as the release-line base. Change both when deliberately introducing a new major/minor version. Automatic builds stamp the next patch into the packages and record it in a tag without committing generated version bumps to main. Manually created release tags must match the source versions exactly. Tags from topic branches are rejected by the manual release job. See [publish.md](../publish.md) for the release and store-publishing procedure.
