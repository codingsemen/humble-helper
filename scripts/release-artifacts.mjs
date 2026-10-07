import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { assertReleaseVersion, effectiveReleaseVersion } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultReleaseDirectory = path.join(root, "release-artifacts");
const browsers = ["chrome", "firefox"];
const maximumArtifactBytes = 50 * 1024 * 1024;
const runFile = promisify(execFile);
const usage = "Usage: node scripts/release-artifacts.mjs prepare <vMAJOR.MINOR.PATCH> | verify <tag> [directory] [chrome|firefox] [--source-ref <same release tag>]";

export function releaseVersionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag || "");
  if (!match || match[0] !== tag) {
    throw new Error("Release tags must use the form vMAJOR.MINOR.PATCH without leading zeroes");
  }
  const version = match.slice(1).join(".");
  return assertReleaseVersion(version);
}

export function releaseArtifactNames(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || "")) {
    throw new Error("Invalid release version");
  }
  assertReleaseVersion(version);
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
  const effectiveVersion = effectiveReleaseVersion(packageMetadata.version, manifest.version);
  if (effectiveVersion !== version) {
    throw new Error(
      `Tag version ${version} must match the effective build version ${effectiveVersion}`
    );
  }
  return { packageMetadata, manifest };
}

export function validateReleasedSourceMetadata(tag, packageMetadata, manifest) {
  const version = releaseVersionFromTag(tag);
  // Supply the released version explicitly: a newer current-main base or an
  // ambient build override must not change validation of immutable old assets.
  effectiveReleaseVersion(packageMetadata?.version, manifest?.version, version);
  if (!manifest?.browser_specific_settings?.gecko?.id) {
    throw new Error("Released source must contain a Firefox extension ID");
  }
  return { packageMetadata, manifest };
}

export async function assertRepositoryVersionAtRef(tag, sourceRef = tag) {
  releaseVersionFromTag(tag);
  if (sourceRef !== tag) throw new Error("Artifact source ref must be its exact release tag");
  const readSource = async (filename) => {
    const { stdout } = await runFile("git", ["show", `${sourceRef}:${filename}`], {
      cwd: root, shell: false, windowsHide: true, timeout: 30_000,
      maxBuffer: 1024 * 1024, encoding: "utf8"
    });
    return JSON.parse(stdout);
  };
  const [packageMetadata, manifest] = await Promise.all([
    readSource("package.json"), readSource("manifest.json")
  ]);
  return validateReleasedSourceMetadata(tag, packageMetadata, manifest);
}

export function validateReleasedManifest({ tag, browser, manifest, sourceManifest }) {
  const version = releaseVersionFromTag(tag);
  if (!browsers.includes(browser) || !manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Released package must contain a browser manifest object");
  }
  if (manifest.version !== version || manifest.manifest_version !== sourceManifest?.manifest_version) {
    throw new Error(`Released manifest must match ${tag} and its released manifest schema`);
  }
  const actualGuid = manifest.browser_specific_settings?.gecko?.id;
  const expectedGuid = sourceManifest?.browser_specific_settings?.gecko?.id;
  if (!expectedGuid || (browser === "firefox" ? actualGuid !== expectedGuid : actualGuid !== undefined)) {
    throw new Error("Released manifest has an unexpected Firefox extension ID");
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

export async function verifyRelease(tag, directoryArgument, target, sourceRef) {
  const version = releaseVersionFromTag(tag);
  await (sourceRef
    ? assertRepositoryVersionAtRef(tag, sourceRef)
    : assertRepositoryVersion(version));
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

export function parseReleaseArtifactArguments(arguments_) {
  const [command, ...rawArguments] = arguments_;
  if (rawArguments[0] === "--") {
    rawArguments.shift();
  }
  const tag = rawArguments.shift();
  if (!tag || !["prepare", "verify"].includes(command)) throw new Error(usage);
  releaseVersionFromTag(tag);
  if (command === "prepare") {
    if (rawArguments.length) throw new Error(usage);
    return { command, tag };
  }
  const positionals = [];
  let sourceRef;
  while (rawArguments.length) {
    const argument = rawArguments.shift();
    if (argument === "--source-ref" && sourceRef === undefined && rawArguments[0]) {
      sourceRef = rawArguments.shift();
      if (sourceRef !== tag) throw new Error("Artifact source ref must be its exact release tag");
    } else if (argument.startsWith("--") || positionals.length === 2 || sourceRef !== undefined) {
      throw new Error(usage);
    } else {
      positionals.push(argument);
    }
  }
  const [directory, target] = positionals;
  if (target && !browsers.includes(target)) throw new Error("Verification target must be chrome or firefox");
  return { command, tag, directory, target, sourceRef };
}

async function main() {
  const { command, tag, directory, target, sourceRef } = parseReleaseArtifactArguments(process.argv.slice(2));
  if (command === "prepare") {
    await prepareRelease(tag);
    return;
  }
  if (command === "verify") {
    await verifyRelease(tag, directory, target, sourceRef);
    return;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
