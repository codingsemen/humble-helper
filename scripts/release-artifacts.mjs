import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultReleaseDirectory = path.join(root, "release-artifacts");
const browsers = ["chrome", "firefox"];
const maximumArtifactBytes = 50 * 1024 * 1024;

function assertChromeCompatibleVersion(version) {
  const components = version.split(".").map(Number);
  if (components.some((component) => component > 65_535) || components.every((component) => component === 0)) {
    throw new Error("Release version components must satisfy Chrome's 0-65535 manifest limits");
  }
}

export function releaseVersionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag || "");
  if (!match) {
    throw new Error("Release tags must use the form vMAJOR.MINOR.PATCH without leading zeroes");
  }
  const version = match.slice(1).join(".");
  assertChromeCompatibleVersion(version);
  return version;
}

export function releaseArtifactNames(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || "")) {
    throw new Error("Invalid release version");
  }
  assertChromeCompatibleVersion(version);
  return Object.fromEntries(browsers.map((browser) => [
    browser,
    `humble-helper-${version}-${browser}.zip`
  ]));
}

export function parseChecksumFile(source, expectedFilenames) {
  const checksums = new Map();
  const lines = source.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid SHA256SUMS entry: ${line}`);
    }
    if (checksums.has(match[2])) {
      throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
    }
    checksums.set(match[2], match[1]);
  }

  const expected = [...expectedFilenames].sort();
  const actual = [...checksums.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("SHA256SUMS must contain exactly the Firefox and Chrome release packages");
  }

  return checksums;
}

async function sha256(file) {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function assertRegularArtifact(file) {
  const stats = await lstat(file);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Release artifact must be a regular file: ${path.relative(root, file)}`);
  }
  if (stats.size === 0 || stats.size > maximumArtifactBytes) {
    throw new Error(`Release artifact has an unexpected size: ${path.relative(root, file)}`);
  }
}

async function assertRepositoryVersion(version) {
  const [packageMetadata, manifest] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "manifest.json"), "utf8").then(JSON.parse)
  ]);
  if (packageMetadata.version !== version || manifest.version !== version) {
    throw new Error(
      `Tag version ${version} must match package.json and manifest.json (${packageMetadata.version}, ${manifest.version})`
    );
  }
}

async function prepareRelease(tag) {
  const version = releaseVersionFromTag(tag);
  await assertRepositoryVersion(version);

  try {
    const stats = await lstat(defaultReleaseDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Refusing to replace release-artifacts because it is not a regular directory");
    }
    await rm(defaultReleaseDirectory, { recursive: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(defaultReleaseDirectory, { recursive: true });

  const names = releaseArtifactNames(version);
  const checksumEntries = [];
  for (const browser of browsers) {
    const artifactDirectory = path.join(root, "artifacts", browser);
    const directoryStats = await lstat(artifactDirectory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error(`Artifact path must be a regular directory: artifacts/${browser}`);
    }

    const candidates = (await readdir(artifactDirectory))
      .filter((entry) => entry.toLowerCase().endsWith(".zip"));
    if (candidates.length !== 1) {
      throw new Error(`Expected exactly one ZIP in artifacts/${browser}, found ${candidates.length}`);
    }

    const source = path.join(artifactDirectory, candidates[0]);
    const destination = path.join(defaultReleaseDirectory, names[browser]);
    await assertRegularArtifact(source);
    await copyFile(source, destination);
    await assertRegularArtifact(destination);
    checksumEntries.push(`${await sha256(destination)}  ${names[browser]}`);
  }

  checksumEntries.sort();
  await writeFile(
    path.join(defaultReleaseDirectory, "SHA256SUMS"),
    `${checksumEntries.join("\n")}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  process.stdout.write(`Prepared release artifacts for ${tag}.\n`);
}

async function verifyRelease(tag, directoryArgument, target) {
  const version = releaseVersionFromTag(tag);
  await assertRepositoryVersion(version);
  if (target && !browsers.includes(target)) {
    throw new Error("Verification target must be chrome or firefox");
  }

  const directory = directoryArgument
    ? path.resolve(root, directoryArgument)
    : defaultReleaseDirectory;
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Release artifact path must be a regular directory");
  }

  const names = releaseArtifactNames(version);
  const checksums = parseChecksumFile(
    await readFile(path.join(directory, "SHA256SUMS"), "utf8"),
    Object.values(names)
  );
  const targets = target ? [target] : browsers;
  for (const browser of targets) {
    const file = path.join(directory, names[browser]);
    await assertRegularArtifact(file);
    const actual = await sha256(file);
    if (actual !== checksums.get(names[browser])) {
      throw new Error(`Checksum mismatch for ${names[browser]}`);
    }
  }
  process.stdout.write(`Verified ${targets.join(" and ")} release artifacts for ${tag}.\n`);
}

async function main() {
  const [command, ...rawArguments] = process.argv.slice(2);
  if (rawArguments[0] === "--") {
    rawArguments.shift();
  }
  const [tag, directory, target] = rawArguments;
  if (command === "prepare" && tag) {
    await prepareRelease(tag);
    return;
  }
  if (command === "verify" && tag) {
    await verifyRelease(tag, directory, target);
    return;
  }
  throw new Error(
    "Usage: node scripts/release-artifacts.mjs prepare <vMAJOR.MINOR.PATCH> | verify <tag> [directory] [chrome|firefox]"
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
