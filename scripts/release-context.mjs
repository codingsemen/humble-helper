import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { releaseVersionFromTag } from "./release-artifacts.mjs";
import { compareReleaseVersions } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
const listingJobName = "Synchronize metadata without uploading an extension";
const listingWorkflows = ["release-main.yml", "sync-firefox-listing.yml"];
const maximumPages = 10;
const pageSize = 100;
const shaPattern = /^[a-f0-9]{40}$/;

export function selectPublishedReleaseTag(releases) {
  if (!Array.isArray(releases)) throw new Error("GitHub releases must be an array");
  let selected = "";
  for (const release of releases) {
    if (!release || typeof release.tag_name !== "string" || typeof release.draft !== "boolean"
      || typeof release.prerelease !== "boolean") {
      throw new Error("GitHub returned an invalid release");
    }
    if (release.draft || release.prerelease
      || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name)) continue;
    const version = releaseVersionFromTag(release.tag_name);
    if (!selected || compareReleaseVersions(version, selected.slice(1)) > 0) selected = release.tag_name;
  }
  return selected;
}

function assetPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f:]/.test(value)
    || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Listing assets must use safe repository-relative paths");
  }
  return value;
}

export function listingRelevantPaths(listing) {
  if (!listing || !Array.isArray(listing.previews)) throw new Error("Firefox listing has no previews");
  return [...new Set([
    "store/firefox/listing.json",
    "scripts/sync-amo-listing.mjs",
    "scripts/run-amo-listing-sync.mjs",
    "scripts/check-amo-version.mjs",
    "scripts/release-version.mjs",
    "scripts/release-artifacts.mjs",
    ".github/workflows/sync-firefox-listing.yml",
    "icons/",
    assetPath(listing.icon),
    ...listing.previews.map((preview) => assetPath(preview?.path))
  ])];
}

export function hasListingChanges(changedPaths, listing) {
  if (!Array.isArray(changedPaths) || changedPaths.some((entry) => typeof entry !== "string")) {
    throw new Error("Changed repository paths must be strings");
  }
  const relevant = listingRelevantPaths(listing);
  return changedPaths.some((changed) => relevant.some((entry) =>
    entry.endsWith("/") ? changed.startsWith(entry) : changed === entry
  ));
}

async function git(arguments_) {
  const { stdout } = await runFile("git", arguments_, {
    cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`GitHub returned an invalid ${label}`);
  }
  return Date.parse(value);
}

function listingJobAttempts(jobs) {
  if (!Array.isArray(jobs)) throw new Error("GitHub workflow jobs must be an array");
  return jobs.filter((job) => job && typeof job.name === "string" && typeof job.conclusion === "string"
    && job.conclusion !== "skipped"
    && (job.name === listingJobName || job.name.endsWith(`/ ${listingJobName}`)))
    .map((job) => ({ ...job, completedTime: timestamp(job.completed_at, "listing completion time") }));
}

export function successfulListingJobs(jobs) {
  return listingJobAttempts(jobs).filter((job) => job.conclusion === "success");
}

export async function readReleaseContext({
  githubRepo = process.env.GH_REPO,
  token = process.env.GH_TOKEN,
  currentRunId = process.env.GITHUB_RUN_ID,
  listing,
  fetchImpl = globalThis.fetch,
  gitImpl = git,
  pageLimit = maximumPages
} = {}) {
  if (typeof githubRepo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    throw new Error("GH_REPO must identify the release repository as owner/name");
  }
  if (typeof token !== "string" || !token) throw new Error("GH_TOKEN is required to inspect release and listing history");
  if (currentRunId !== undefined && !/^\d+$/.test(String(currentRunId))) throw new Error("GITHUB_RUN_ID must be numeric");
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > maximumPages) throw new Error("Invalid pagination limit");
  listingRelevantPaths(listing);
  const head = (await gitImpl(["rev-parse", "HEAD"])).trim();
  if (!shaPattern.test(head)) throw new Error("Current source must resolve to a full commit SHA");

  async function request(route, { missingWorkflow = false } = {}) {
    const response = await fetchImpl(`https://api.github.com/repos/${githubRepo}${route}`, {
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (missingWorkflow && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub release context request returned HTTP ${response.status} for ${route}`);
    try { return await response.json(); }
    catch { throw new Error(`GitHub returned invalid JSON for ${route}`); }
  }

  async function pages(route, field, missingWorkflow = false) {
    const entries = [];
    for (let page = 1; page <= pageLimit; page += 1) {
      const payload = await request(`${route}${route.includes("?") ? "&" : "?"}per_page=${pageSize}&page=${page}`, { missingWorkflow });
      if (payload === null) return { entries: [], complete: true };
      const batch = field ? payload?.[field] : payload;
      if (!Array.isArray(batch) || batch.length > pageSize) throw new Error(`GitHub returned an invalid list for ${route}`);
      entries.push(...batch);
      if (batch.length < pageSize) return { entries, complete: true };
    }
    return { entries, complete: false };
  }

  async function isAncestor(sha) {
    try { await gitImpl(["merge-base", "--is-ancestor", sha, head]); return true; }
    catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  }

  const [releases, ...histories] = await Promise.all([
    pages("/releases"),
    ...listingWorkflows.map((workflow) => pages(`/actions/workflows/${workflow}/runs?branch=main&status=completed`, "workflow_runs", true))
  ]);
  if (!releases.complete) throw new Error("GitHub release history exceeds the safe scan limit; refusing an incomplete release baseline");
  const baselineTag = selectPublishedReleaseTag(releases.entries);
  let baselineSha = "";
  if (baselineTag) {
    baselineSha = (await gitImpl(["rev-parse", "--verify", `${baselineTag}^{commit}`])).trim();
    if (!shaPattern.test(baselineSha) || !await isAncestor(baselineSha)) {
      throw new Error(`Release baseline ${baselineTag} is not an ancestor of the tested source`);
    }
  }

  // A bounded or absent listing history forces a repair, never a false no-op.
  let listingBaselineSha = "";
  let latestCompletion = -Infinity;
  let latestFailedCompletion = -Infinity;
  let completeHistory = histories.every((history) => history.complete);
  const candidates = histories.flatMap((history) => history.entries)
    .filter((run) => String(run?.id) !== String(currentRunId)
      && run?.status === "completed" && run.head_branch === "main"
      && ["workflow_run", "workflow_dispatch"].includes(run.event));
  for (const run of candidates) {
    if (!Number.isSafeInteger(run.id) || run.id <= 0 || !shaPattern.test(run.head_sha)
      || run.head_repository?.full_name !== githubRepo) throw new Error("GitHub returned invalid listing workflow provenance");
    run.updatedTime = timestamp(run.updated_at, "workflow update time");
  }
  candidates.sort((left, right) => right.updatedTime - left.updatedTime);
  if (completeHistory) {
    for (const run of candidates) {
      // All jobs finish before the run's final update. Older finished runs
      // cannot contain a more recent sync, so avoid an API call for each one.
      if (run.updatedTime < latestCompletion) break;
      if (!await isAncestor(run.head_sha)) continue;
      // A later retry can fail after an earlier attempt synchronized the listing.
      // Keep that successful state instead of trusting only the latest attempt.
      const jobs = await pages(`/actions/runs/${run.id}/jobs?filter=all`, "jobs");
      if (!jobs.complete) { completeHistory = false; break; }
      for (const job of listingJobAttempts(jobs.entries)) {
        if (job.completedTime > run.updatedTime) throw new Error("Listing job completion exceeds its workflow update time");
        if (job.conclusion !== "success") {
          latestFailedCompletion = Math.max(latestFailedCompletion, job.completedTime);
        } else if (job.completedTime > latestCompletion) {
          latestCompletion = job.completedTime;
          listingBaselineSha = run.head_sha;
        }
      }
    }
  }
  let listingChanged = true;
  if (completeHistory && listingBaselineSha) {
    const changed = await gitImpl(["diff", "--name-only", "-z", listingBaselineSha, head, "--"]);
    // A failed attempt may have changed metadata or removed previews before
    // failing. A later successful sync clears that dirty-state barrier. Equal
    // timestamps are ambiguous at GitHub's second resolution, so repair them.
    listingChanged = latestFailedCompletion >= latestCompletion
      || hasListingChanges(changed.split("\0").filter(Boolean), listing);
  }
  if (!completeHistory) listingBaselineSha = "";
  return { baselineTag, baselineSha, listingChanged, listingBaselineSha };
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/release-context.mjs");
  const listing = JSON.parse(await readFile(path.join(root, "store", "firefox", "listing.json"), "utf8"));
  const context = await readReleaseContext({ listing });
  const outputs = `baseline_tag=${context.baselineTag}\nbaseline_sha=${context.baselineSha}\nlisting_changed=${context.listingChanged}\nlisting_baseline_sha=${context.listingBaselineSha}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, outputs, "utf8");
  process.stdout.write(outputs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.message || error); process.exitCode = 1; });
}
