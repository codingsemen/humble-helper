import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maximumVersionComponent = 65_535;

export function assertReleaseVersion(version) {
  if (typeof version !== "string" || version.trim() !== version || !versionPattern.test(version)) {
    throw new Error("Release versions must use MAJOR.MINOR.PATCH without leading zeroes");
  }
  const components = version.split(".").map(Number);
  if (components.some((component) => component > maximumVersionComponent)
    || components.every((component) => component === 0)) {
    throw new Error("Release version components must satisfy Chrome's 0-65535 manifest limits");
  }
  return version;
}

function versionComponents(version) {
  return assertReleaseVersion(version).split(".").map(Number);
}

export function compareReleaseVersions(left, right) {
  const leftComponents = versionComponents(left);
  const rightComponents = versionComponents(right);
  for (let index = 0; index < leftComponents.length; index += 1) {
    if (leftComponents[index] !== rightComponents[index]) {
      return Math.sign(leftComponents[index] - rightComponents[index]);
    }
  }
  return 0;
}

function sameReleaseLine(left, right) {
  const [leftMajor, leftMinor] = versionComponents(left);
  const [rightMajor, rightMinor] = versionComponents(right);
  return leftMajor === rightMajor && leftMinor === rightMinor;
}

export function effectiveReleaseVersion(packageVersion, manifestVersion, override = process.env.HUMBLE_RELEASE_VERSION) {
  assertReleaseVersion(packageVersion);
  assertReleaseVersion(manifestVersion);
  if (packageVersion !== manifestVersion) {
    throw new Error("manifest.json and package.json versions must match");
  }
  if (override === undefined) {
    return packageVersion;
  }
  assertReleaseVersion(override);
  if (!sameReleaseLine(packageVersion, override) || compareReleaseVersions(override, packageVersion) < 0) {
    throw new Error("HUMBLE_RELEASE_VERSION must use the source major/minor and an equal or newer patch");
  }
  return override;
}

function versionFromKnownTag(tag) {
  // Other repository tags, including prereleases, are not extension releases.
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    return null;
  }
  return assertReleaseVersion(tag.slice(1));
}

export function selectAutomaticReleaseVersion({ sourceVersion, tags = [], amoVersion = null, headTags = [] }) {
  assertReleaseVersion(sourceVersion);
  if (!Array.isArray(tags) || !Array.isArray(headTags)) {
    throw new Error("Release tags must be arrays");
  }
  const tagVersions = [...new Set([...tags, ...headTags].map(versionFromKnownTag).filter(Boolean))];
  const publishedVersions = [...tagVersions];
  if (amoVersion !== null && amoVersion !== undefined) {
    publishedVersions.push(assertReleaseVersion(amoVersion));
  }

  for (const publishedVersion of publishedVersions) {
    if (!sameReleaseLine(sourceVersion, publishedVersion)
      && compareReleaseVersions(publishedVersion, sourceVersion) > 0) {
      throw new Error(
        `Source version ${sourceVersion} would downgrade published version ${publishedVersion}; update package.json and manifest.json`
      );
    }
  }

  const sameLineVersions = publishedVersions.filter((version) => sameReleaseLine(sourceVersion, version));
  const currentHeadVersions = [...new Set(headTags.map(versionFromKnownTag).filter((version) =>
    version && sameReleaseLine(sourceVersion, version) && compareReleaseVersions(version, sourceVersion) >= 0
  ))];
  if (currentHeadVersions.length > 1) {
    throw new Error("HEAD has multiple release version tags; refusing an ambiguous retry");
  }
  if (currentHeadVersions.length === 1) {
    const retryVersion = currentHeadVersions[0];
    if (sameLineVersions.some((version) => compareReleaseVersions(version, retryVersion) > 0)) {
      throw new Error(`Release ${retryVersion} is superseded; refusing to retry an older release`);
    }
    return retryVersion;
  }

  const [major, minor, sourcePatch] = versionComponents(sourceVersion);
  const latestPatch = Math.max(sourcePatch, ...sameLineVersions.map((version) => versionComponents(version)[2]));
  if (latestPatch === maximumVersionComponent) {
    throw new Error("Automatic patch versions are exhausted; increment the source major/minor version");
  }
  return `${major}.${minor}.${latestPatch + 1}`;
}

export function automaticReleaseOutputs(options) {
  const version = selectAutomaticReleaseVersion(options);
  const tag = `v${version}`;
  return { version, tag, reused: (options.headTags || []).includes(tag) };
}

export async function fetchPublicAmoVersion(guid, { fetchImpl = fetch, timeoutMilliseconds = 30_000 } = {}) {
  if (typeof guid !== "string" || guid.length === 0 || guid.trim() !== guid) {
    throw new Error("manifest.json must contain a Gecko extension ID for AMO version lookup");
  }
  const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(guid)}/`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMilliseconds)
  });
  if (!response.ok) {
    throw new Error(`AMO version lookup failed with HTTP ${response.status}; refusing to guess a release version`);
  }
  const addon = await response.json();
  if (addon.guid !== guid) {
    throw new Error("AMO version lookup returned a different extension ID");
  }
  if (!addon.current_version || typeof addon.current_version.version !== "string") {
    throw new Error("AMO has no public current version; refusing to guess a release version");
  }
  return assertReleaseVersion(addon.current_version.version);
}

async function readSourceVersions() {
  const [packageMetadata, manifest] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "manifest.json"), "utf8").then(JSON.parse)
  ]);
  // Selection always starts from the checked-in version, not a packaging override.
  const sourceVersion = effectiveReleaseVersion(packageMetadata.version, manifest.version, packageMetadata.version);
  return { sourceVersion, guid: manifest.browser_specific_settings?.gecko?.id };
}

async function readTags(arguments_) {
  const { stdout } = await runFile("git", ["tag", ...arguments_], {
    cwd: root,
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8"
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (arguments_.length !== 0 || !["next", "check"].includes(command)) {
    throw new Error("Usage: node scripts/release-version.mjs next | check");
  }
  const { sourceVersion, guid } = await readSourceVersions();
  if (command === "check") {
    process.stdout.write(`Source versions aligned at ${sourceVersion}.\n`);
    return;
  }
  const [tags, headTags, amoVersion] = await Promise.all([
    readTags(["--list"]),
    readTags(["--points-at", "HEAD"]),
    fetchPublicAmoVersion(guid)
  ]);
  const { version, tag, reused } = automaticReleaseOutputs({ sourceVersion, tags, headTags, amoVersion });
  const outputs = `version=${version}\ntag=${tag}\nreused=${reused}\n`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, outputs, "utf8");
  }
  process.stdout.write(outputs);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
