# Publishing Humble Helper

This guide describes the repository automation, one-time GitHub and browser-store setup, release procedure, and cost controls. Store requirements change; follow the linked official documentation during initial setup.

## Automation overview

The repository contains six workflows:

- `.github/workflows/ci.yml` tests the exact pull-request head revision, checks JavaScript syntax and dependencies, treats Firefox lint warnings as errors, and builds both browser packages. It runs for pull requests to `main`, pushes to `main`, and manual requests.
- `.github/workflows/security.yml` audits the committed dependency lockfile for high-severity vulnerabilities every Wednesday at 04:17 UTC and on manual request.
- `.github/workflows/release-main.yml` waits for successful push CI on `main`, compares the shipped browser contents with the last published release, and allocates/submits a new patch only when those contents or the deliberate source version changed. Listing changes are synchronized independently. Pull-request/manual CI cannot trigger deployment. Superseded main revisions are skipped.
- `.github/workflows/release.yml` accepts only `vMAJOR.MINOR.PATCH` tags on `main`, repeats the release gates, creates distinct Firefox and Chrome ZIPs plus `SHA256SUMS`, and publishes generated GitHub release notes.
- `.github/workflows/publish-stores.yml` downloads and verifies an existing GitHub Release and submits that version to Mozilla Add-ons or the Chrome Web Store. It can be called by the release workflow or run manually; it does not modify the Firefox listing.
- `.github/workflows/sync-firefox-listing.yml` uses successful, current-main CI tooling to update the listing for an existing AMO version, without uploading extension code or allocating a version. It is independently runnable from `main`.

Dependabot (not Renovate) checks npm and pinned GitHub Actions versions on Monday mornings. A check need not create a new PR when dependencies are already current or an update PR is open. Dependabot security updates are advisory-driven and require repository security settings in addition to `dependabot.yml`. Security update PRs are grouped separately from weekly version updates.

CI and release gates use `pnpm run audit:release`, which rejects high/critical findings except for the narrowly scoped, expiring [node-forge exception](docs/SECURITY-EXCEPTIONS.md). The weekly raw audit intentionally has no exceptions, so this known finding remains visible until upstream fixes it. Audit failures do not modify the lockfile or repair vulnerabilities; the dependency update must be merged.

Store publishing is disabled by default. Automatic release publishing is controlled independently by two repository-level Actions variables:

- `ENABLE_FIREFOX_PUBLISHING=true` enables successful-main automatic patch releases and Firefox submissions, as well as submission of manually tagged releases.
- `ENABLE_CHROME_PUBLISHING=true` submits the release to the Chrome Web Store.

These are Actions **Variables**, not Secrets. Leave either variable unset (or set it to `false`) to skip that store. Main-merge automation submits only Firefox; Chrome remains an explicit manual/tag-release option. The manual **Publish browser stores** workflow does not depend on these flags.

## Required GitHub repository settings

Some protections cannot be committed as files. Configure these after the first push.

### Actions

Under **Settings -> Actions -> General**:

1. Allow the actions used by this repository. If using an allowlist, permit `actions/*` and `google-github-actions/auth@*`.
2. Set default `GITHUB_TOKEN` workflow permissions to **Read repository contents** and do not allow Actions to approve pull requests.
3. Keep fork pull-request workflows approval-gated for first-time or untrusted contributors.

Every external action in this repository is pinned to a full commit SHA. Individual jobs request write or OIDC permission only when they need it.

### Protect `main` and release tags

Create a branch ruleset for `main` with these settings:

- Require a pull request before merging.
- Require `CI / Branch checks` to pass.
- Require the topic branch to be up to date before merging, so its tested head already contains current `main`.
- Require one approval when another reviewer is available and dismiss stale approvals.
- Require a linear history; use squash merges.
- Block force pushes and deletion, including for administrators where practical.

Create a tag ruleset for `v*` that blocks updates and deletion. If tag creation is restricted, allow the release workflow's GitHub Actions identity as well as the maintainer; otherwise automatic version reservation will fail. A protected tag is important because a workflow definition is loaded from the tagged commit itself.

Create the release-note labels referenced by `.github/release.yml` if they are not already present: `breaking-change`, `security`, `feature`, `fix`, `dependencies`, `documentation`, and `skip-changelog`. The standard `bug` and `enhancement` labels are also recognized.

Rulesets and protected branches are available for public repositories on GitHub Free. Private repositories on a personal GitHub Free account have fewer ruleset and protected-environment features.

### Repository security

Under **Settings -> Security -> Advanced Security**, enable the dependency graph, Dependabot alerts, and Dependabot security updates. The committed `dependabot.yml` enables version updates. Also enable private vulnerability reporting and secret scanning or push protection when those controls are available for the repository.

### `browser-stores` environment

Create an environment named `browser-stores`:

- Allow deployments from `main` (the automatic caller runs there) and `v*` tags (manual tagged releases).
- For hands-off publishing after CI, do not require an environment reviewer. Add a reviewer only if you intentionally want a final approval click before each store submission.
- If this is a solo repository, do not enable "prevent self-review" unless another reviewer is configured.
- Store the Mozilla secrets and Chrome variables below in this environment when possible. Keep the two enable flags above as repository-level **Variables**; the release caller job cannot read environment-scoped variables before it selects which store workflow to invoke.

On GitHub Free, environment reviewers, environment secrets, and deployment branch/tag restrictions are available for public repositories but not private repositories. For a private Free repository, keep the automatic publishing flags unset and run the store workflow manually using repository-level secrets and variables; that retains a deliberate click-to-publish gate.

## GitHub Actions cost and safeguards

Standard GitHub-hosted runners are free for public repositories. GitHub Free currently includes 500 MB of artifact storage shared with Packages and 10 GB of Actions cache storage per repository; private repositories also draw from a 2,000-minute monthly runner allowance. Dependabot usage is free. Larger runners are always metered.

If the account has no valid payment method, GitHub blocks additional Actions usage after the included quota is exhausted. It does not silently charge an account with no payment method. A failed or blocked pipeline is still possible, so configure explicit controls:

1. Open [personal billing settings](https://github.com/settings/billing), choose **Budgets and alerts**, and create an Actions product budget of zero (or the lowest value the UI permits) with **Stop usage when budget limit is reached** enabled.
2. Enable included-usage alerts at 90% and 100%.
3. Review Actions usage periodically, especially if the repository is private.
4. Do not enable larger runners for this repository.

The committed workflows also conserve usage: they use Linux standard runners, cancel superseded CI runs, apply bounded timeouts, create no pull-request artifacts, disable dependency caches, retain release handoff artifacts for one day, and do not wait on a runner for store review. Dependency audits run in CI/releases and weekly. Release and store jobs serialize with `queue: max` so pending submissions are not replaced ([GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).

GitHub automatically disables scheduled workflows in a public repository after 60 days without repository activity. Re-enable the weekly security workflow from the Actions tab if that happens.

Current limits and controls are documented by GitHub in [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets), and [deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Automatic releases after merging to main

1. Enable the repository Actions variable `ENABLE_FIREFOX_PUBLISHING=true` and configure the AMO secrets in `browser-stores`.
2. Merge a tested PR. After the exact main revision passes **CI / Branch checks**, **Automatic Firefox release** decides which deployment jobs are needed.
3. The allocator considers the checked-in base version, all release tags (including pending pipeline submissions), and AMO's public version. With base/public `0.2.0`, the first automatic release is `0.2.1`, then `0.2.2`.
4. For new functionality, manually update both `package.json` and `manifest.json` to the desired major/minor base in the PR. For example, a `0.3.0` base starts automatic releases at `0.3.1`.

Automatic patches are stamped into the packaged manifests; source versions stay aligned at the chosen base. There are no bot commits to main, no extra version-bump PRs, and no recursive pipeline triggers. The release tag records the exact tested source. GitHub's built-in token creates that tag without triggering the manual tag-release workflow; the automatic workflow calls store publishing directly.

### Changes that trigger deployment

| Change | Result after successful main CI |
| --- | --- |
| Extension JavaScript, HTML, CSS, icons, or effective manifest/build output | New patch release and Firefox submission |
| Deliberate aligned version change in `package.json` and `manifest.json` | New release in the selected version line |
| Firefox listing JSON, referenced store images, or listing-sync tooling | Update the existing AMO listing; no new extension version |
| Pipeline, docs, tests, or publishing-tool dependency changes with identical browser contents | No extension release |

The gate builds comparison ZIPs at the checked-in source version and compares their Firefox and Chrome contents against checksum-verified ZIPs from the highest stable published GitHub Release. Generated manifest version stamps, manifest JSON key ordering, and ZIP container metadata are ignored. It compares with the last release, not the preceding commit, so changes from earlier skipped merges are included. Dependency/build changes release only if they alter shipped contents, including changed packaging exclusions. A missing or corrupt release baseline blocks the job; only a repository with no canonical stable published releases takes the explicit initial-release path.

Listing changes are compared with the last successful listing-sync job on main, including when another job in that run failed. A later failed or cancelled sync forces repair on the next successful main merge even when its inputs did not change, because preview replacement may have partially changed remote state. Unrelated merges do not repeatedly delete/reupload unchanged screenshots. If no usable synchronization history is available, one conservative listing refresh establishes a new baseline. Every automatic/tagged extension submission also synchronizes its listing.

A successful main revision superseded by a newer merge is skipped, so late CI cannot overwrite newer code. A fresh release whose version is already occupied on AMO fails rather than silently treating a manual upload as its own submission. Stop standalone manual uploads after enabling automation; use the pipeline and its recorded tags for version reservation.

If a failure happened before publishing the GitHub Release, rerun the failed automatic workflow to reuse its reserved version/draft. If the GitHub Release already exists but store submission failed, run **Publish browser stores** from current, CI-tested `main` with that existing tag. This retries the same immutable Firefox package with repaired publishing tooling and does not allocate another version. After a manual Firefox submission retry, run **Synchronize Firefox listing** for that existing version separately. Re-running CI is not needed to resend an unchanged package.

Mozilla may still review submissions before making them public. A successful submission is not a guarantee of immediate listing availability.

## Optional manually tagged release

Use automatic releases for normal merges. To deliberately publish a source-matching manual tag instead, disable `ENABLE_FIREFOX_PUBLISHING` before that merge so the automatic release does not compete with it, then use the manual store workflow. Do not add a lower source-base tag after the automatic workflow has already allocated its patch.

1. Create a normal topic branch following [docs/BRANCHING.md](docs/BRANCHING.md).
2. Update the same version in `package.json` and `manifest.json`.
3. Run:

   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   pnpm test
   pnpm run check
   pnpm run audit:release
   pnpm run build
   ```

4. Merge the pull request into `main`.
5. Tag the merged commit and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag -s v0.3.0 -m "Humble Helper 0.3.0"
   git push origin v0.3.0
   ```

   Use an annotated tag (`git tag -a`) if commit/tag signing is not configured.

6. Watch **Actions -> Release**. The workflow creates a draft first, attaches `humble-helper-VERSION-firefox.zip`, `humble-helper-VERSION-chrome.zip`, and `SHA256SUMS`, then publishes the release with notes generated from merged pull requests and labels.
7. If either store flag is enabled, the corresponding submission runs (with an approval click only if you configured an environment reviewer). To retry one store independently, run **Actions -> Publish browser stores**, enter the existing release tag, and choose `firefox` or `chrome`.

If Firefox submission succeeds but the listing synchronization job fails, use the independent **Synchronize Firefox listing** workflow described below. No new package or patch version is necessary for listing or pipeline fixes. Changing the listing default locale requires values for every populated translated field. The synchronization script preserves existing dashboard-managed fields by carrying their old-default fallback into the new locale, including support email and the original support URL.

A published release is intentionally not mutated on rerun. If the release job fails before publication, rerunning it safely completes the existing draft.

## Mozilla Add-ons setup

Firefox packages must be signed by Mozilla. The workflow uses Mozilla's maintained `web-ext sign` flow with the `listed` channel, API credentials supplied only to the protected store job, and `--approval-timeout 0` so GitHub does not spend minutes waiting for review.

The repository-managed AMO listing is [`store/firefox/listing.json`](store/firefox/listing.json). After a version submission succeeds, or when listing inputs change without a package release, a separate protected workflow updates the listing metadata, uploads the icon, replaces the AMO preview set with the committed screenshots, and applies optional version release notes. The current preview files are shared with the Chrome listing under `store/chrome/`; edit the committed files and captions in a pull request before publishing.

### Update or repair the existing listing without a release

1. Merge the listing/tooling fix into `main` and let that exact revision pass push CI.
2. The automatic workflow synchronizes changed listing inputs without creating a new extension version. To retry explicitly, open **Actions -> Synchronize Firefox listing -> Run workflow**, select `main`, and leave `version` empty to target AMO's current public version (currently `0.2.1`), or enter an already-submitted listed version such as `0.2.1`.
3. The workflow rejects stale or untested main revisions and nonexistent/rejected target versions before changing the listing. A listed version awaiting review can be targeted explicitly. Store operations share the publishing concurrency queue.

This sync changes name, summary, description, homepage, configured support fields, categories, flags, icon, screenshots/captions, and optional release notes. It does not replace the extension package, bump its version, change account credentials, or manage AMO-only reviewer/policy settings. Screenshot replacement is not transactional: a later API failure can leave a partial preview set, so retry the listing workflow after fixing the cause.

The original `0.2.1` failure was a metadata validation error: AMO's existing default locale was `de`, with support email and support URL only in German. Switching the default to `en-US` without supplying English fallback values made AMO reject the first metadata PATCH with HTTP 400. The package submission was successful; icon and screenshot updates had not started. The migration now preserves those contacts and translations.

1. Create an AMO developer account and API credentials.
2. Add these environment or repository secrets:

   - `AMO_JWT_ISSUER`
   - `AMO_JWT_SECRET`

3. Add the repository Actions variable `ENABLE_FIREFOX_PUBLISHING=true` when you want successful main merges and tagged releases to submit automatically. Leave it unset while you are still configuring AMO.

4. Review `store/firefox/listing.json` for the repository-managed listing content. The workflow generates the small AMO submission metadata file from this source at release time. AMO-only policy or reviewer fields that are not represented in the file still require a one-time dashboard setup.

5. Validate the repository-managed listing locally without contacting AMO:

   ```bash
   node scripts/sync-amo-listing.mjs --dry-run
   ```

The manifest already includes a stable Firefox extension ID, which is required for update submissions. See Mozilla's [web-ext signing reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) and [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/).

## Chrome Web Store setup

Chrome Web Store API V2 can update an existing item but cannot create the first item. Create the listing, complete its Store Listing and Privacy sections, enable two-step verification, and publish manually once before enabling automation.

The workflow uses a Google service account and GitHub OIDC Workload Identity Federation. This produces a short-lived access token and avoids storing a Google client secret, refresh token, or service-account JSON key.

1. Create or select a Google Cloud project and enable the Chrome Web Store API.
2. Create a service account and add its email in the Chrome Web Store Developer Dashboard under the publisher account settings.
3. Configure a Google Workload Identity Pool/provider for GitHub. Restrict its attribute condition to this repository (`codingsemen/humble-helper`) and, when configured, the `browser-stores` environment. Grant that repository principal `roles/iam.workloadIdentityUser` on the service account.
4. Add these environment or repository variables:

   - `GCP_WORKLOAD_IDENTITY_PROVIDER` - the full provider resource name
   - `GCP_SERVICE_ACCOUNT` - the service account email
   - `CHROME_PUBLISHER_ID` - the publisher ID from the Developer Dashboard
   - `CHROME_EXTENSION_ID` - the existing 32-character Chrome extension ID

5. Follow Google's [service-account setup](https://developer.chrome.com/docs/webstore/service-accounts) and [Workload Identity Federation guidance](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines). Test with the manual Chrome target first.
6. Set `ENABLE_CHROME_PUBLISHING=true` only after the Chrome listing has passed review, the API credentials work with the manual `chrome` target, and the environment approval gate is configured. Until then, leave it unset or `false`; Firefox can remain enabled independently.

The Chrome job downloads the released ZIP, verifies its SHA-256 checksum, uploads it through API V2, waits only for asynchronous upload processing, rejects upload failures and validation warnings, and submits the item for review. Store review and eventual publication remain controlled by Google.

## Troubleshooting

- Manual tag release rejected immediately: the tag must be `vMAJOR.MINOR.PATCH`, match both version files, and point to a commit contained in `main`. Automatic tags can have a newer patch than the source base, but must use the same major/minor.
- Automatic main release skipped: ensure `ENABLE_FIREFOX_PUBLISHING` is a repository Actions **Variable** set to `true`, the triggering CI was a successful push to `main`, and its source is still the current main revision.
- Package jobs skipped with `packaged-content-unchanged`: expected for pipeline, documentation, test, and listing-only changes; successful CI is still required.
- Listing-only repair: run **Synchronize Firefox listing** on current, CI-tested `main`; do not create a new extension version to repair metadata.
- Security findings repeat: merge the dependency fix; rerunning the same committed lockfile will report the same findings. The approved node-forge finding remains visible in weekly scans. Enable Dependabot alerts and security updates in repository settings to get advisory-driven fix PRs.
- Required CI check is missing: run one pull request after adding the workflow, then select `CI / Branch checks` in the ruleset.
- Firefox submission asks for metadata: verify `store/firefox/listing.json`, the generated submission metadata step, and the AMO listing state.
- Chrome OIDC authentication fails: verify the provider resource name, service-account email, `roles/iam.workloadIdentityUser` binding, repository condition, and environment name.
- Chrome upload fails: the version must be greater than the store version and the service account must be linked to the correct publisher.
- Weekly audit stopped running: public-repository schedules are disabled after 60 days without activity; re-enable the workflow.
