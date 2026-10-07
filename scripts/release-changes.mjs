import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertReleaseVersion, compareReleaseVersions } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
// Keep aligned with prepare-build.mjs. Dependencies are development tools, not bundled code.
const extensionFiles = new Set([
  "background.js", "shared.js", "popup.html", "popup.css", "popup.js",
  "options.html", "options.css", "options.js", "manifest.json",
  "scripts/prepare-build.mjs", "scripts/build-extensions.mjs"
]);

export function hasExtensionChanges(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.some((entry) => typeof entry !== "string")) {
    throw new Error("Changed repository paths must be strings");
  }
  return changedPaths.some((entry) => extensionFiles.has(entry)
    || entry.startsWith("content/") || entry.startsWith("icons/"));
}

export function selectPublishedReleaseTag(releases) {
  if (!Array.isArray(releases)) throw new Error("GitHub releases must be an array");
  let selected = "";
  for (const release of releases) {
    if (!release || typeof release.tagName !== "string") throw new Error("GitHub returned an invalid release");
    const tag = release.tagName;
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) continue;
    const version = assertReleaseVersion(tag.slice(1));
    if (!selected || compareReleaseVersions(version, selected.slice(1)) > 0) selected = tag;
  }
  return selected;
}

export async function detectExtensionChanges({
  githubRepo = process.env.GH_REPO, token = process.env.GH_TOKEN,
  sourceSha = process.env.SOURCE_SHA, cwd = root, readReleases, gitImpl
} = {}) {
  if (typeof githubRepo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    throw new Error("GH_REPO must identify the release repository as owner/name");
  }
  if (typeof token !== "string" || !token) throw new Error("GH_TOKEN is required to inspect published releases");
  const command = async (binary, args) => (await runFile(binary, args, {
    cwd, shell: false, windowsHide: true, encoding: "utf8", timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_REPO: githubRepo, GH_TOKEN: token }
  })).stdout;
  const git = gitImpl || ((args) => command("git", args));
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (!shaPattern.test(head) || (sourceSha !== undefined && (!shaPattern.test(sourceSha) || sourceSha !== head))) {
    throw new Error("SOURCE_SHA must be the full commit SHA of the checked-out tested source");
  }
  const releases = await (readReleases || (async () => JSON.parse(await command("gh", [
    "release", "list", "--repo", githubRepo, "--exclude-drafts", "--exclude-pre-releases",
    "--limit", "1000", "--json", "tagName"
  ]))))();
  if (Array.isArray(releases) && releases.length >= 1000) {
    throw new Error("GitHub release history exceeds the scan limit; refusing an incomplete release baseline");
  }
  const baselineTag = selectPublishedReleaseTag(releases);
  if (!baselineTag) return { needsRelease: true, baselineTag, sourceSha: head, changedFiles: [] };
  const baselineSha = (await git(["rev-parse", "--verify", `${baselineTag}^{commit}`])).trim();
  if (!shaPattern.test(baselineSha)) throw new Error("Release baseline must resolve to a full commit SHA");
  try { await git(["merge-base", "--is-ancestor", baselineSha, head]); }
  catch (error) {
    if (error.code === 1) throw new Error(`Release baseline ${baselineTag} is not an ancestor of the tested source`);
    throw error;
  }
  // Compare cumulatively from the last published release, including removed/renamed sources.
  const changedFiles = (await git(["diff", "--name-only", "--no-renames", "-z", baselineSha, head, "--"]))
    .split("\0").filter(Boolean);
  return { needsRelease: hasExtensionChanges(changedFiles), baselineTag, sourceSha: head, changedFiles };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args.length) throw new Error("Usage: node scripts/release-changes.mjs");
  const decision = await detectExtensionChanges();
  const outputs = `needs_release=${decision.needsRelease}\nbaseline_tag=${decision.baselineTag}\nsource_sha=${decision.sourceSha}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, outputs, "utf8");
  process.stdout.write(outputs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.message || error); process.exitCode = 1; });
}
