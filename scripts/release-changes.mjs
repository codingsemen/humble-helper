import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { parseChecksumFile, releaseArtifactNames, releaseVersionFromTag } from "./release-artifacts.mjs";
import { assertReleaseVersion, effectiveReleaseVersion } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
const browsers = ["firefox", "chrome"];
const maximumBytes = 50 * 1024 * 1024;
const maximumEntries = 1_000;
const usage = "Usage: node scripts/release-changes.mjs --baseline-dir <directory> --tag <vMAJOR.MINOR.PATCH> [--source-ref <release SHA>] [--current-artifacts <directory>] | --bootstrap [--current-artifacts <directory>]";
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertPath(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || /[\x00-\x1f\x7f:]/.test(name)
    || name.normalize("NFC") !== name || name.startsWith("/")
    || name.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
    throw new Error(`Unsafe package path: ${JSON.stringify(name)}`);
  }
}

function assertExtraFields(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error("Invalid ZIP extra field");
    }
    const identifier = buffer.readUInt16LE(offset);
    const length = buffer.readUInt16LE(offset + 2);
    if (identifier === 0x0001 || offset + 4 + length > buffer.length) {
      throw new Error("ZIP64 or malformed ZIP extra fields are not supported");
    }
    offset += 4 + length;
  }
}

// Inspect packages in memory: nothing from a downloaded ZIP is extracted to disk.
// Validate the complete archive before deciding that a release can be skipped.
export function readReleaseZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > maximumBytes) {
    throw new Error("Release ZIP has an unexpected size");
  }
  let end = -1;
  const minimumEnd = Math.max(0, buffer.length - 22 - 65_535);
  for (let offset = buffer.length - 22; offset >= minimumEnd; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  if (end === -1) {
    throw new Error("ZIP end-of-directory record is missing or malformed");
  }
  const entries = buffer.readUInt16LE(end + 10);
  const centralBytes = buffer.readUInt32LE(end + 12);
  const centralStart = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0
    || buffer.readUInt16LE(end + 8) !== entries || !entries || entries > maximumEntries
    || centralStart === 0xffffffff || centralBytes === 0xffffffff
    || centralStart + centralBytes !== end) {
    throw new Error("Multi-volume, ZIP64, empty, or oversized release ZIP is not supported");
  }

  const files = new Map();
  const names = new Set();
  const directories = new Set();
  const ranges = [];
  let totalBytes = 0;
  let cursor = centralStart;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP central-directory entry");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localStart = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (next > end || !nameBytes || buffer.readUInt16LE(cursor + 34) !== 0
      || flags & ~0x0808 || ![0, 8].includes(method)
      || compressedBytes === 0xffffffff || uncompressedBytes > maximumBytes
      || localStart + 30 > centralStart) {
      throw new Error("Unsupported or malformed ZIP entry");
    }
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameBytes);
    const entryName = decoder.decode(rawName);
    const isDirectory = entryName.endsWith("/");
    const name = isDirectory ? entryName.slice(0, -1) : entryName;
    assertPath(name);
    const key = name.toLowerCase();
    if (names.has(key)) {
      throw new Error(`Duplicate ZIP path: ${name}`);
    }
    names.add(key);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType && unixType !== (isDirectory ? 0x4000 : 0x8000)) {
      throw new Error(`ZIP entry is not a regular file or directory: ${name}`);
    }
    assertExtraFields(buffer.subarray(cursor + 46 + nameBytes, cursor + 46 + nameBytes + extraBytes));

    if (buffer.readUInt32LE(localStart) !== 0x04034b50
      || buffer.readUInt16LE(localStart + 6) !== flags
      || buffer.readUInt16LE(localStart + 8) !== method) {
      throw new Error(`ZIP local header does not match its directory: ${name}`);
    }
    const localNameBytes = buffer.readUInt16LE(localStart + 26);
    const localExtraBytes = buffer.readUInt16LE(localStart + 28);
    const dataStart = localStart + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataStart + compressedBytes;
    if (dataEnd > centralStart || localNameBytes !== nameBytes
      || !buffer.subarray(localStart + 30, localStart + 30 + localNameBytes).equals(rawName)) {
      throw new Error(`ZIP local path or data bounds are invalid: ${name}`);
    }
    assertExtraFields(buffer.subarray(localStart + 30 + localNameBytes, dataStart));
    const localChecksum = buffer.readUInt32LE(localStart + 14);
    const localCompressedBytes = buffer.readUInt32LE(localStart + 18);
    const localUncompressedBytes = buffer.readUInt32LE(localStart + 22);
    const descriptor = Boolean(flags & 0x0008);
    if ((!descriptor && (localChecksum !== checksum || localCompressedBytes !== compressedBytes
      || localUncompressedBytes !== uncompressedBytes))
      || (descriptor && ((localChecksum !== 0 && localChecksum !== checksum)
        || (localCompressedBytes !== 0 && localCompressedBytes !== compressedBytes)
        || (localUncompressedBytes !== 0 && localUncompressedBytes !== uncompressedBytes)))) {
      throw new Error(`ZIP local sizes or checksum do not match: ${name}`);
    }
    let entryEnd = dataEnd;
    if (descriptor) {
      if (entryEnd + 12 > centralStart) {
        throw new Error(`ZIP data descriptor is missing: ${name}`);
      }
      if (buffer.readUInt32LE(entryEnd) === 0x08074b50) {
        entryEnd += 4;
      }
      if (entryEnd + 12 > centralStart || buffer.readUInt32LE(entryEnd) !== checksum
        || buffer.readUInt32LE(entryEnd + 4) !== compressedBytes
        || buffer.readUInt32LE(entryEnd + 8) !== uncompressedBytes) {
        throw new Error(`ZIP data descriptor does not match: ${name}`);
      }
      entryEnd += 12;
    }
    ranges.push([localStart, entryEnd]);
    totalBytes += uncompressedBytes;
    if (totalBytes > maximumBytes) {
      throw new Error("Uncompressed release ZIP exceeds the size limit");
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? compressed : inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, uncompressedBytes)
    });
    if (data.length !== uncompressedBytes || crc32(data) !== checksum) {
      throw new Error(`ZIP content size or checksum does not match: ${name}`);
    }
    if (isDirectory) {
      if (data.length) {
        throw new Error(`ZIP directory contains file data: ${name}`);
      }
      directories.add(key);
    } else {
      files.set(name, data);
    }
    cursor = next;
  }
  if (cursor !== end) {
    throw new Error("ZIP central-directory size or count does not match");
  }
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges[0][0] !== 0 || ranges.at(-1)[1] !== centralStart
    || ranges.some((range, index) => index && ranges[index - 1][1] !== range[0])) {
    throw new Error("ZIP entries overlap or leave unaccounted file data");
  }
  const fileKeys = new Set([...files.keys()].map((name) => name.toLowerCase()));
  for (const name of [...files.keys(), ...directories]) {
    const parts = name.toLowerCase().split("/");
    parts.pop();
    while (parts.length) {
      if (fileKeys.has(parts.join("/"))) {
        throw new Error(`ZIP file and directory paths conflict: ${name}`);
      }
      parts.pop();
    }
  }
  return files;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function normalizedPackage(files, expectedVersion) {
  if (!(files instanceof Map) || !files.size || !files.has("manifest.json")) {
    throw new Error("Release package must contain manifest.json");
  }
  const normalized = new Map(files);
  for (const [name, bytes] of files) {
    assertPath(name);
    if (!Buffer.isBuffer(bytes)) {
      throw new Error(`Package content must be a Buffer: ${name}`);
    }
  }
  const manifest = JSON.parse(decoder.decode(files.get("manifest.json")));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Release manifest must be a JSON object");
  }
  assertReleaseVersion(manifest.version);
  if (manifest.version !== expectedVersion) {
    throw new Error(`Package manifest version ${manifest.version} does not match expected ${expectedVersion}`);
  }
  delete manifest.version;
  normalized.set("manifest.json", Buffer.from(JSON.stringify(canonicalJson(manifest))));
  return normalized;
}

export function compareReleasePackages({ currentPackages, baselinePackages, sourceVersion,
  baselineSourceVersion, baselineReleaseVersion }) {
  assertReleaseVersion(sourceVersion);
  effectiveReleaseVersion(baselineSourceVersion, baselineSourceVersion, baselineReleaseVersion);
  const changedFiles = [];
  for (const browser of browsers) {
    const current = normalizedPackage(currentPackages?.[browser], sourceVersion);
    const baseline = normalizedPackage(baselinePackages?.[browser], baselineReleaseVersion);
    const names = [...new Set([...current.keys(), ...baseline.keys()])].sort();
    for (const name of names) {
      if (!current.has(name) || !baseline.has(name) || !current.get(name).equals(baseline.get(name))) {
        changedFiles.push(`${browser}/${name}`);
      }
    }
  }
  const versionChanged = sourceVersion !== baselineSourceVersion;
  const needsRelease = versionChanged || changedFiles.length > 0;
  const reason = versionChanged ? "source-version-changed"
    : changedFiles.length ? "packaged-content-changed" : "packaged-content-unchanged";
  return { needsRelease, reason, changedFiles };
}

async function readRegularFile(file, limit = maximumBytes) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) {
    throw new Error(`Expected a bounded regular file: ${file}`);
  }
  const bytes = await readFile(file);
  if (bytes.length !== stats.size) {
    throw new Error(`File changed while it was being read: ${file}`);
  }
  return bytes;
}

export async function readPackageDirectory(directory) {
  const files = new Map();
  const names = new Set();
  let totalBytes = 0;
  let entries = 0;
  async function visit(current, prefix, depth) {
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory() || depth > 32) {
      throw new Error(`Expected a regular package directory: ${current}`);
    }
    for (const name of (await readdir(current)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      assertPath(relative);
      const key = relative.toLowerCase();
      if (names.has(key) || ++entries > maximumEntries) {
        throw new Error(`Duplicate path or oversized package directory: ${relative}`);
      }
      names.add(key);
      const child = path.join(current, name);
      const childStats = await lstat(child);
      if (childStats.isSymbolicLink()) {
        throw new Error(`Refusing package symbolic link: ${relative}`);
      }
      if (childStats.isDirectory()) {
        await visit(child, relative, depth + 1);
      } else {
        const bytes = await readRegularFile(child);
        totalBytes += bytes.length;
        if (totalBytes > maximumBytes) {
          throw new Error("Package directory exceeds the size limit");
        }
        files.set(relative, bytes);
      }
    }
  }
  await visit(directory, "", 0);
  return files;
}

export async function readBaselinePackages(directory, tag) {
  const version = releaseVersionFromTag(tag);
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Baseline artifacts must be in a regular directory");
  }
  const names = releaseArtifactNames(version);
  const checksums = parseChecksumFile(
    (await readRegularFile(path.join(directory, "SHA256SUMS"), 16 * 1024)).toString("utf8"),
    Object.values(names)
  );
  const packages = {};
  for (const browser of browsers) {
    const name = names[browser];
    const bytes = await readRegularFile(path.join(directory, name));
    if (createHash("sha256").update(bytes).digest("hex") !== checksums.get(name)) {
      throw new Error(`Baseline checksum mismatch for ${name}`);
    }
    packages[browser] = readReleaseZip(bytes);
  }
  return packages;
}

export async function readCurrentArtifactPackages(directory) {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Current artifacts must be in a regular directory");
  }
  const packages = {};
  for (const browser of browsers) {
    const browserDirectory = path.join(directory, browser);
    const browserStats = await lstat(browserDirectory);
    if (!browserStats.isDirectory() || browserStats.isSymbolicLink()) {
      throw new Error(`Current ${browser} artifacts must be in a regular directory`);
    }
    const candidates = (await readdir(browserDirectory)).filter((name) => name.toLowerCase().endsWith(".zip"));
    if (candidates.length !== 1) {
      throw new Error(`Expected exactly one current ZIP in artifacts/${browser}, found ${candidates.length}`);
    }
    packages[browser] = readReleaseZip(await readRegularFile(path.join(browserDirectory, candidates[0])));
  }
  return packages;
}

function parseArguments(arguments_) {
  const options = {};
  if (arguments_[0] === "--") arguments_.shift();
  while (arguments_.length) {
    const flag = arguments_.shift();
    if (flag === "--bootstrap" && !options.bootstrap) {
      options.bootstrap = true;
    } else if (["--baseline-dir", "--tag", "--source-ref", "--current-artifacts"].includes(flag)
      && !Object.hasOwn(options, flag) && arguments_[0] && !arguments_[0].startsWith("--")) {
      options[flag] = arguments_.shift();
    } else {
      throw new Error(usage);
    }
  }
  if (options.bootstrap ? Object.keys(options).some((key) => !["bootstrap", "--current-artifacts"].includes(key))
    : !options["--baseline-dir"] || !options["--tag"]) {
    throw new Error("Use a complete release baseline, or explicitly request --bootstrap");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [packageMetadata, manifest, currentPackages] = await Promise.all([
    readRegularFile(path.join(root, "package.json")).then((bytes) => JSON.parse(bytes.toString("utf8"))),
    readRegularFile(path.join(root, "manifest.json")).then((bytes) => JSON.parse(bytes.toString("utf8"))),
    options["--current-artifacts"]
      ? readCurrentArtifactPackages(path.resolve(root, options["--current-artifacts"]))
      : Promise.all(browsers.map((browser) => readPackageDirectory(path.join(root, "dist", browser))))
        .then((packages) => Object.fromEntries(browsers.map((browser, index) => [browser, packages[index]])))
  ]);
  const sourceVersion = effectiveReleaseVersion(packageMetadata.version, manifest.version, packageMetadata.version);
  let decision;
  if (options.bootstrap) {
    for (const browser of browsers) {
      normalizedPackage(currentPackages[browser], sourceVersion);
    }
    decision = { needsRelease: true, reason: "initial-release", changedFiles: [] };
  } else {
    const tag = options["--tag"];
    const baselineReleaseVersion = releaseVersionFromTag(tag);
    const sourceRef = options["--source-ref"] || tag;
    if (sourceRef !== tag && !/^[a-f0-9]{40}$/.test(sourceRef)) {
      throw new Error("Baseline source ref must be its release tag or a full commit SHA");
    }
    const [baselinePackages, source] = await Promise.all([
      readBaselinePackages(path.resolve(root, options["--baseline-dir"]), tag),
      runFile("git", ["show", `${sourceRef}:package.json`], {
        cwd: root, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8"
      })
    ]);
    const baselineSourceVersion = JSON.parse(source.stdout).version;
    decision = compareReleasePackages({ currentPackages, baselinePackages, sourceVersion,
      baselineSourceVersion, baselineReleaseVersion });
  }
  const outputs = `needs_release=${decision.needsRelease}\nreason=${decision.reason}\n`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, outputs, "utf8");
  }
  process.stdout.write(outputs);
  if (decision.changedFiles.length) {
    process.stdout.write(`Changed packaged files: ${decision.changedFiles.join(", ")}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
