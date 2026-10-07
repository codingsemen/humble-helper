const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { deflateRawSync } = require("node:zlib");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "release-changes.mjs"));

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let index = 0; index < 8; index += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries, { compressed = false, descriptor = false, timestamp = 0 } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.bytes ?? "");
    const payload = compressed ? deflateRawSync(bytes) : bytes;
    const checksum = crc32(bytes);
    const flags = 0x0800 | (descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt16LE(timestamp, 10);
    if (!descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(bytes.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const dataDescriptor = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      dataDescriptor.writeUInt32LE(0x08074b50);
      dataDescriptor.writeUInt32LE(checksum, 4);
      dataDescriptor.writeUInt32LE(payload.length, 8);
      dataDescriptor.writeUInt32LE(bytes.length, 12);
    }
    locals.push(local, name, payload, dataDescriptor);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(compressed ? 8 : 0, 10);
    header.writeUInt16LE(timestamp, 12);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(entry.attributes ?? (entry.name.endsWith("/") ? 0x41ed0000 : 0x81a40000), 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + payload.length + dataDescriptor.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function packageFiles(version, overrides = {}) {
  return new Map(Object.entries({
    "manifest.json": JSON.stringify({ manifest_version: 3, version, name: "Humble Helper", permissions: ["storage"] }),
    "background.js": "console.log('helper');\n",
    "icons/icon.svg": "<svg></svg>\n",
    ...overrides
  }).map(([name, bytes]) => [name, Buffer.from(bytes)]));
}

function comparison(overrides = {}) {
  return {
    sourceVersion: "0.2.0",
    baselineSourceVersion: "0.2.0",
    baselineReleaseVersion: "0.2.1",
    currentPackages: { firefox: packageFiles("0.2.0"), chrome: packageFiles("0.2.0") },
    baselinePackages: { firefox: packageFiles("0.2.1"), chrome: packageFiles("0.2.1") },
    ...overrides
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "humble-release-changes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("automatic patch stamps and manifest JSON ordering do not create another release", async () => {
  const { compareReleasePackages } = await import(moduleUrl);
  const input = comparison();
  input.currentPackages.firefox.set("manifest.json", Buffer.from(
    '{"permissions":["storage"],"name":"Humble Helper","version":"0.2.0","manifest_version":3}\n'
  ));
  assert.deepEqual(compareReleasePackages(input), {
    needsRelease: false, reason: "packaged-content-unchanged", changedFiles: []
  });
});

test("changes to either browser's shipped code, permissions, or assets require a release", async () => {
  const { compareReleasePackages } = await import(moduleUrl);
  for (const browser of ["firefox", "chrome"]) {
    for (const [name, bytes] of [
      ["background.js", "console.log('changed shipped output');\n"],
      ["icons/icon.svg", "<svg><path /></svg>\n"],
      ["manifest.json", JSON.stringify({ manifest_version: 3, version: "0.2.0", name: "Humble Helper", permissions: ["storage", "tabs"] })]
    ]) {
      const input = comparison();
      input.currentPackages[browser].set(name, Buffer.from(bytes));
      assert.deepEqual(compareReleasePackages(input), {
        needsRelease: true, reason: "packaged-content-changed", changedFiles: [`${browser}/${name}`]
      });
    }
  }
});

test("added and removed shipped files are detected against the last release", async () => {
  const { compareReleasePackages } = await import(moduleUrl);
  const input = comparison();
  input.currentPackages.firefox.set("content/new.js", Buffer.from("console.log('new');"));
  input.currentPackages.chrome.delete("icons/icon.svg");
  assert.deepEqual(compareReleasePackages(input), {
    needsRelease: true, reason: "packaged-content-changed",
    changedFiles: ["firefox/content/new.js", "chrome/icons/icon.svg"]
  });
});

test("intentional checked-in version increments are not erased by manifest normalization", async () => {
  const { compareReleasePackages } = await import(moduleUrl);
  for (const version of ["0.2.2", "0.3.0", "1.0.0"]) {
    assert.deepEqual(compareReleasePackages(comparison({
      sourceVersion: version,
      currentPackages: { firefox: packageFiles(version), chrome: packageFiles(version) }
    })), { needsRelease: true, reason: "source-version-changed", changedFiles: [] });
  }
});

test("missing, malformed, or incorrectly stamped manifests fail closed", async () => {
  const { compareReleasePackages } = await import(moduleUrl);
  for (const bytes of [null, "{}", "null", "[]", "not JSON", '{"version":"0.2.2"}']) {
    const input = comparison();
    if (bytes === null) {
      input.baselinePackages.firefox.delete("manifest.json");
    } else {
      input.baselinePackages.firefox.set("manifest.json", Buffer.from(bytes));
    }
    assert.throws(() => compareReleasePackages(input));
  }
  assert.throws(() => compareReleasePackages(comparison({ baselineSourceVersion: "0.3.0" })), /source major\/minor/);
  assert.throws(() => compareReleasePackages(comparison({ baselinePackages: { firefox: packageFiles("0.2.1") } })), /manifest.json/);
  const input = comparison();
  input.currentPackages.chrome.set("manifest.json", Buffer.from('{"version":"0.2.1"}'));
  assert.throws(() => compareReleasePackages(input), /does not match expected/);
});

test("ZIP compression, timestamps, and data descriptors do not affect packaged content", async () => {
  const { readReleaseZip } = await import(moduleUrl);
  const entries = [...packageFiles("0.2.1")].map(([name, bytes]) => ({ name, bytes }));
  const first = readReleaseZip(zip(entries));
  for (const options of [{ compressed: true }, { timestamp: 48_111 }, { compressed: true, descriptor: true }]) {
    assert.deepEqual(readReleaseZip(zip(entries, options)), first);
  }
  assert.deepEqual(readReleaseZip(zip([{ name: "icons/" }, ...entries])), first);
});

test("ZIP traversal, duplicate paths, symbolic links, and file-directory conflicts are rejected", async () => {
  const { readReleaseZip } = await import(moduleUrl);
  for (const name of ["../manifest.json", "/manifest.json", "a/../b.js", "a//b.js", "a\\b.js", "C:/b.js", "a/b.js.", "a/b.js ", "a/\u0000b.js"]) {
    assert.throws(() => readReleaseZip(zip([{ name, bytes: "payload" }])));
  }
  for (const entries of [
    [{ name: "manifest.json" }, { name: "manifest.json" }],
    [{ name: "manifest.json" }, { name: "MANIFEST.json" }],
    [{ name: "icons", bytes: "file" }, { name: "icons/icon.svg", bytes: "nested file" }],
    [{ name: "icons/", bytes: "unexpected directory data" }],
    [{ name: "background.js", bytes: "target", attributes: 0xa1ff0000 }]
  ]) {
    assert.throws(() => readReleaseZip(zip(entries)));
  }
});

test("corrupt ZIP bytes, inconsistent local headers, overlaps, encryption, and oversized data fail", async () => {
  const { readReleaseZip } = await import(moduleUrl);
  const archive = zip([{ name: "manifest.json", bytes: '{"version":"0.2.1"}' }]);
  const central = archive.readUInt32LE(archive.length - 6);
  const mutations = [
    (bytes) => { bytes[30 + "manifest.json".length] ^= 1; },
    (bytes) => bytes.writeUInt32LE(1, 18),
    (bytes) => bytes.writeUInt32LE(1, central + 42),
    (bytes) => bytes.writeUInt16LE(0x0801, central + 8),
    (bytes) => bytes.writeUInt16LE(12, central + 10),
    (bytes) => bytes.writeUInt32LE(51 * 1024 * 1024, central + 24),
    (bytes) => bytes.writeUInt16LE(2, bytes.length - 12),
    (bytes) => bytes.writeUInt16LE(1, bytes.length - 18)
  ];
  for (const mutate of mutations) {
    const copy = Buffer.from(archive);
    mutate(copy);
    assert.throws(() => readReleaseZip(copy));
  }
  assert.throws(() => readReleaseZip(Buffer.concat([archive, Buffer.from("extra")])));
  assert.throws(() => readReleaseZip(archive.subarray(0, archive.length - 1)));
  assert.throws(() => readReleaseZip(zip([])));
});

test("a false uncompressed length cannot bypass bounded decompression", async () => {
  const { readReleaseZip } = await import(moduleUrl);
  const archive = zip([{ name: "background.js", bytes: "A".repeat(1024) }], { compressed: true });
  const central = archive.readUInt32LE(archive.length - 6);
  archive.writeUInt32LE(1, 22);
  archive.writeUInt32LE(1, central + 24);
  assert.throws(() => readReleaseZip(archive));
});

test("baseline loading verifies both immutable packages and exactly their checksums", async (t) => {
  const { readBaselinePackages } = await import(moduleUrl);
  const directory = await temporaryDirectory(t);
  const names = ["humble-helper-0.2.1-firefox.zip", "humble-helper-0.2.1-chrome.zip"];
  const bytes = zip([...packageFiles("0.2.1")].map(([name, bytes]) => ({ name, bytes })), { compressed: true });
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const sums = names.map((name) => `${checksum}  ${name}`).join("\n") + "\n";
  for (const name of names) {
    await writeFile(path.join(directory, name), bytes);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), sums);
  assert.deepEqual(await readBaselinePackages(directory, "v0.2.1"), {
    firefox: packageFiles("0.2.1"), chrome: packageFiles("0.2.1")
  });
  await writeFile(path.join(directory, names[1]), "not a package");
  await assert.rejects(readBaselinePackages(directory, "v0.2.1"), /checksum mismatch/);
  await rm(path.join(directory, names[1]));
  await assert.rejects(readBaselinePackages(directory, "v0.2.1"), /ENOENT/);
  await writeFile(path.join(directory, names[1]), bytes);
  await writeFile(path.join(directory, "SHA256SUMS"), `${sums}${checksum}  extra.zip\n`);
  await assert.rejects(readBaselinePackages(directory, "v0.2.1"), /exactly the Firefox and Chrome/);
});

test("the package directory gate ignores files outside dist but detects changed build output", async (t) => {
  const { compareReleasePackages, readPackageDirectory } = await import(moduleUrl);
  const directory = await temporaryDirectory(t);
  for (const browser of ["firefox", "chrome"]) {
    const dist = path.join(directory, "dist", browser);
    await mkdir(path.join(dist, "icons"), { recursive: true });
    for (const [name, bytes] of packageFiles("0.2.0")) {
      await writeFile(path.join(dist, name), bytes);
    }
  }
  await mkdir(path.join(directory, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(directory, "store", "firefox"), { recursive: true });
  await mkdir(path.join(directory, "test"), { recursive: true });
  await writeFile(path.join(directory, ".github", "workflows", "release.yml"), "changed pipeline");
  await writeFile(path.join(directory, "store", "firefox", "listing.json"), "changed listing");
  await writeFile(path.join(directory, "test", "helper.test.js"), "changed test");
  await writeFile(path.join(directory, "README.md"), "changed docs");
  await writeFile(path.join(directory, "pnpm-lock.yaml"), "changed tooling dependencies");
  const currentPackages = {
    firefox: await readPackageDirectory(path.join(directory, "dist", "firefox")),
    chrome: await readPackageDirectory(path.join(directory, "dist", "chrome"))
  };
  assert.equal(compareReleasePackages(comparison({ currentPackages })).needsRelease, false);
  await writeFile(path.join(directory, "dist", "chrome", "background.js"), "new bundled dependency output");
  currentPackages.chrome = await readPackageDirectory(path.join(directory, "dist", "chrome"));
  assert.deepEqual(compareReleasePackages(comparison({ currentPackages })).changedFiles, ["chrome/background.js"]);
});

test("final ZIP comparison detects changed build exclusions even when prepared dist is unchanged", async (t) => {
  const { compareReleasePackages, readCurrentArtifactPackages } = await import(moduleUrl);
  const directory = await temporaryDirectory(t);
  for (const browser of ["firefox", "chrome"]) {
    await mkdir(path.join(directory, browser));
    const files = packageFiles("0.2.0");
    if (browser === "chrome") files.delete("icons/icon.svg");
    await writeFile(path.join(directory, browser, "package.zip"), zip(
      [...files].map(([name, bytes]) => ({ name, bytes })), { compressed: true, descriptor: true, timestamp: 12_345 }
    ));
  }
  const currentPackages = await readCurrentArtifactPackages(directory);
  assert.deepEqual(compareReleasePackages(comparison({ currentPackages })), {
    needsRelease: true, reason: "packaged-content-changed", changedFiles: ["chrome/icons/icon.svg"]
  });
  await writeFile(path.join(directory, "chrome", "package.zip"), zip(
    [...packageFiles("0.2.0")].map(([name, bytes]) => ({ name, bytes })), { timestamp: 48_111 }
  ));
  assert.equal(compareReleasePackages(comparison({ currentPackages: await readCurrentArtifactPackages(directory) })).needsRelease, false);
  await writeFile(path.join(directory, "firefox", "package.zip"), zip(
    [...packageFiles("0.2.0", { "background.js": "transformed final output" })].map(([name, bytes]) => ({ name, bytes }))
  ));
  assert.deepEqual(compareReleasePackages(comparison({ currentPackages: await readCurrentArtifactPackages(directory) })).changedFiles,
    ["firefox/background.js"]);
});

test("current artifact loading rejects missing, multiple, malformed, and symlinked browser packages", async (t) => {
  const { readCurrentArtifactPackages } = await import(moduleUrl);
  const directory = await temporaryDirectory(t);
  const packages = path.join(directory, "artifacts");
  for (const browser of ["firefox", "chrome"]) await mkdir(path.join(packages, browser), { recursive: true });
  await assert.rejects(readCurrentArtifactPackages(packages), /exactly one current ZIP/);
  const bytes = zip([...packageFiles("0.2.0")].map(([name, bytes]) => ({ name, bytes })));
  for (const browser of ["firefox", "chrome"]) await writeFile(path.join(packages, browser, "one.zip"), bytes);
  await writeFile(path.join(packages, "firefox", "two.ZIP"), bytes);
  await assert.rejects(readCurrentArtifactPackages(packages), /exactly one current ZIP/);
  await rm(path.join(packages, "firefox", "two.ZIP"));
  await writeFile(path.join(packages, "chrome", "one.zip"), "not a ZIP");
  await assert.rejects(readCurrentArtifactPackages(packages), /unexpected size/);
  await rm(path.join(packages, "chrome", "one.zip"));
  await symlink(path.join(packages, "firefox"), path.join(packages, "chrome", "one.zip"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readCurrentArtifactPackages(packages), /bounded regular file/);
  const linkedRoot = path.join(directory, "linked-artifacts");
  await symlink(packages, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readCurrentArtifactPackages(linkedRoot), /regular directory/);
});

test("directory readers reject symbolic links instead of following them", async (t) => {
  const { readBaselinePackages, readCurrentArtifactPackages, readPackageDirectory } = await import(moduleUrl);
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "target");
  const linked = path.join(directory, "linked");
  await mkdir(target);
  await writeFile(path.join(target, "manifest.json"), '{"version":"0.2.0"}');
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readPackageDirectory(linked), /regular package directory/);
  await assert.rejects(readBaselinePackages(linked, "v0.2.1"), /regular directory/);
  await assert.rejects(readCurrentArtifactPackages(linked), /regular directory/);
  await mkdir(path.join(directory, "dist"));
  await symlink(target, path.join(directory, "dist", "icons"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readPackageDirectory(path.join(directory, "dist")), /symbolic link/);
});

test("CLI requires an explicit bootstrap or a complete baseline and fails before emitting a decision", async () => {
  const script = path.resolve(__dirname, "..", "scripts", "release-changes.mjs");
  for (const arguments_ of [
    [], ["--tag", "v0.2.1"], ["--baseline-dir", "missing"],
    ["--bootstrap", "--tag", "v0.2.1"], ["--bootstrap", "--bootstrap"],
    ["--bootstrap", "--current-artifacts", "missing", "--baseline-dir", "missing"],
    ["--bootstrap", "--current-artifacts"],
    ["--baseline-dir", "missing", "--tag", "invalid"],
    ["--baseline-dir", "missing", "--tag", "v0.2.1", "--source-ref", "HEAD"],
    ["--baseline-dir", "missing", "--tag", "v0.2.1", "--tag", "v0.2.1"]
  ]) {
    const result = spawnSync(process.execPath, [script, ...arguments_], {
      encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" }, timeout: 30_000, windowsHide: true
    });
    assert.equal(result.status, 1, `${JSON.stringify(arguments_)}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /needs_release=/);
  }
});

test("CLI bootstrap validates source/dist versions and writes GitHub action outputs", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputFile = path.join(directory, "outputs");
  await mkdir(path.join(directory, "scripts"));
  for (const name of ["release-changes.mjs", "release-artifacts.mjs", "release-version.mjs"]) {
    await copyFile(path.resolve(__dirname, "..", "scripts", name), path.join(directory, "scripts", name));
  }
  await writeFile(path.join(directory, "package.json"), '{"version":"0.2.0"}');
  await writeFile(path.join(directory, "manifest.json"), '{"version":"0.2.0"}');
  for (const browser of ["firefox", "chrome"]) {
    const dist = path.join(directory, "dist", browser);
    await mkdir(path.join(dist, "icons"), { recursive: true });
    for (const [name, bytes] of packageFiles("0.2.0")) {
      await writeFile(path.join(dist, name), bytes);
    }
  }
  const script = path.join(directory, "scripts", "release-changes.mjs");
  const result = spawnSync(process.execPath, [script, "--bootstrap"], {
    encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputFile }, timeout: 30_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "needs_release=true\nreason=initial-release\n");
  assert.equal(await readFile(outputFile, "utf8"), result.stdout);
  const pnpmSeparator = spawnSync(process.execPath, [script, "--", "--bootstrap"], {
    encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" }, timeout: 30_000, windowsHide: true
  });
  assert.equal(pnpmSeparator.status, 0, pnpmSeparator.stderr);
  assert.equal(pnpmSeparator.stdout, result.stdout);
  await rm(outputFile);
  const artifacts = path.join(directory, "artifacts");
  for (const browser of ["firefox", "chrome"]) {
    await mkdir(path.join(artifacts, browser), { recursive: true });
    await writeFile(path.join(artifacts, browser, "package.zip"), zip(
      [...packageFiles("0.2.0")].map(([name, bytes]) => ({ name, bytes })), { compressed: true }
    ));
  }
  const artifactResult = spawnSync(process.execPath, [script, "--bootstrap", "--current-artifacts", artifacts], {
    encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputFile }, timeout: 30_000, windowsHide: true
  });
  assert.equal(artifactResult.status, 0, artifactResult.stderr);
  assert.equal(artifactResult.stdout, result.stdout);
  assert.equal(await readFile(outputFile, "utf8"), result.stdout);
  await rm(outputFile);
  await writeFile(path.join(artifacts, "chrome", "package.zip"), zip(
    [{ name: "manifest.json", bytes: '{"version":"0.2.1"}' }]
  ));
  const incorrectlyStampedArtifact = spawnSync(process.execPath, [script, "--bootstrap", "--current-artifacts", artifacts], {
    encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputFile }, timeout: 30_000, windowsHide: true
  });
  assert.equal(incorrectlyStampedArtifact.status, 1);
  assert.match(incorrectlyStampedArtifact.stderr, /does not match expected/);
  assert.doesNotMatch(incorrectlyStampedArtifact.stdout, /needs_release=/);
  await assert.rejects(readFile(outputFile), /ENOENT/);
  await writeFile(path.join(directory, "dist", "firefox", "manifest.json"), '{"version":"0.2.1"}');
  const incorrectlyStamped = spawnSync(process.execPath, [script, "--bootstrap"], {
    encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputFile }, timeout: 30_000, windowsHide: true
  });
  assert.equal(incorrectlyStamped.status, 1);
  assert.match(incorrectlyStamped.stderr, /does not match expected/);
  assert.doesNotMatch(incorrectlyStamped.stdout, /needs_release=/);
  await assert.rejects(readFile(outputFile), /ENOENT/);
});
