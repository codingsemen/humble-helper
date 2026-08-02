# Publishing Humble Helper

This guide describes the repository automation, one-time GitHub and browser-store setup, release procedure, and cost controls. Store requirements change; follow the linked official documentation during initial setup.

## Automation overview

The repository contains four workflows:

- `.github/workflows/ci.yml` tests the exact pull-request head revision, checks JavaScript syntax, treats Firefox lint warnings as errors, and builds both browser packages. It runs for pull requests to `main`, pushes to `main`, and manual requests.
- `.github/workflows/security.yml` audits the committed dependency lockfile for high-severity vulnerabilities every Wednesday at 04:17 UTC and on manual request.
- `.github/workflows/release.yml` accepts only `vMAJOR.MINOR.PATCH` tags on `main`, repeats the release gates, creates distinct Firefox and Chrome ZIPs plus `SHA256SUMS`, and publishes generated GitHub release notes.
- `.github/workflows/publish-stores.yml` downloads and verifies an existing GitHub Release, then submits that version to Mozilla Add-ons, the Chrome Web Store, or both. It can be called by the release workflow or run manually.

Dependabot checks npm and pinned GitHub Actions versions on Monday mornings. Dependabot security updates are advisory-driven; the weekly schedule controls ordinary version updates and complements the weekly lockfile audit.

Store publishing is disabled by default. The release workflow calls the store workflow only when the repository variable `ENABLE_STORE_PUBLISHING` is exactly `true`.

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

Create a tag ruleset for `v*` that blocks updates and deletion and limits tag creation to the maintainer. A protected tag is important because a workflow definition is loaded from the tagged commit itself.

Create the release-note labels referenced by `.github/release.yml` if they are not already present: `breaking-change`, `security`, `feature`, `fix`, `dependencies`, `documentation`, and `skip-changelog`. The standard `bug` and `enhancement` labels are also recognized.

Rulesets and protected branches are available for public repositories on GitHub Free. Private repositories on a personal GitHub Free account have fewer ruleset and protected-environment features.

### Repository security

Under **Settings -> Security -> Advanced Security**, enable the dependency graph, Dependabot alerts, and Dependabot security updates. The committed `dependabot.yml` enables version updates. Also enable private vulnerability reporting and secret scanning or push protection when those controls are available for the repository.

### `browser-stores` environment

Create an environment named `browser-stores`:

- For a public repository, require a reviewer and allow deployments from `v*` tags. Also allow `main` only if the manual store workflow will be launched from `main`.
- If this is a solo repository, do not enable "prevent self-review" unless another reviewer is configured.
- Store the Mozilla secrets and Chrome variables below in the environment when possible.

On GitHub Free, environment reviewers, environment secrets, and deployment branch/tag restrictions are available for public repositories but not private repositories. For a private Free repository, keep `ENABLE_STORE_PUBLISHING` unset and run the store workflow manually using repository-level secrets and variables; that retains a deliberate click-to-publish gate.

## GitHub Actions cost and safeguards

Standard GitHub-hosted runners are free for public repositories. GitHub Free currently includes 500 MB of artifact storage shared with Packages and 10 GB of Actions cache storage per repository; private repositories also draw from a 2,000-minute monthly runner allowance. Dependabot usage is free. Larger runners are always metered.

If the account has no valid payment method, GitHub blocks additional Actions usage after the included quota is exhausted. It does not silently charge an account with no payment method. A failed or blocked pipeline is still possible, so configure explicit controls:

1. Open [personal billing settings](https://github.com/settings/billing), choose **Budgets and alerts**, and create an Actions product budget of zero (or the lowest value the UI permits) with **Stop usage when budget limit is reached** enabled.
2. Enable included-usage alerts at 90% and 100%.
3. Review Actions usage periodically, especially if the repository is private.
4. Do not enable larger runners for this repository.

The committed workflows also conserve usage: they use Linux standard runners, cancel superseded CI runs, apply 10- or 15-minute timeouts, create no pull-request artifacts, disable dependency caches, run the CVE audit weekly, retain the release handoff artifact for one day, and do not wait on a runner for store review.

GitHub automatically disables scheduled workflows in a public repository after 60 days without repository activity. Re-enable the weekly security workflow from the Actions tab if that happens.

Current limits and controls are documented by GitHub in [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets), and [deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Create a release

1. Create a normal topic branch following [docs/BRANCHING.md](docs/BRANCHING.md).
2. Update the same version in `package.json` and `manifest.json`.
3. Run:

   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   pnpm test
   pnpm run check
   pnpm run audit
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
7. If automatic store publishing is enabled, approve the `browser-stores` deployment. Otherwise run **Actions -> Publish browser stores**, enter the existing release tag, and choose a target.

A published release is intentionally not mutated on rerun. If the release job fails before publication, rerunning it safely completes the existing draft.

## Mozilla Add-ons setup

Firefox packages must be signed by Mozilla. The workflow uses Mozilla's maintained `web-ext sign` flow with the `listed` channel, API credentials supplied only to the protected store job, and `--approval-timeout 0` so GitHub does not spend minutes waiting for review.

1. Create an AMO developer account and API credentials.
2. Add these environment or repository secrets:

   - `AMO_JWT_ISSUER`
   - `AMO_JWT_SECRET`

3. Review `store/amo-metadata.json`. It contains the minimum metadata needed for an initial listing. Complete the listing, privacy declarations, screenshots, support details, and reviewer information in AMO.

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
6. Set `ENABLE_STORE_PUBLISHING=true` only after both stores work and the environment approval gate is configured.

The Chrome job downloads the released ZIP, verifies its SHA-256 checksum, uploads it through API V2, waits only for asynchronous upload processing, rejects upload failures and validation warnings, and submits the item for review. Store review and eventual publication remain controlled by Google.

## Troubleshooting

- Release rejected immediately: the tag must be `vMAJOR.MINOR.PATCH`, match both version files, and point to a commit contained in `main`.
- Required CI check is missing: run one pull request after adding the workflow, then select `CI / Branch checks` in the ruleset.
- Firefox submission asks for metadata: verify `store/amo-metadata.json` and the AMO listing state.
- Chrome OIDC authentication fails: verify the provider resource name, service-account email, `roles/iam.workloadIdentityUser` binding, repository condition, and environment name.
- Chrome upload fails: the version must be greater than the store version and the service account must be linked to the correct publisher.
- Weekly audit stopped running: public-repository schedules are disabled after 60 days without activity; re-enable the workflow.
