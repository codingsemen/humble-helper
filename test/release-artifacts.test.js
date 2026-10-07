const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "release-artifacts.mjs"));

test("release tags and browser artifact names are deterministic", async () => {
  const { releaseArtifactNames, releaseVersionFromTag } = await import(moduleUrl);
  assert.equal(releaseVersionFromTag("v1.2.3"), "1.2.3");
  assert.deepEqual(releaseArtifactNames("1.2.3"), {
    chrome: "humble-helper-1.2.3-chrome.zip",
    firefox: "humble-helper-1.2.3-firefox.zip"
  });
  for (const invalid of [
    "1.2.3",
    "v1.2",
    "v01.2.3",
    "v1.2.3-beta",
    "v1.2.3;echo",
    "v0.0.0",
    "v65536.1.1"
  ]) {
    assert.throws(() => releaseVersionFromTag(invalid));
  }
});

test("release checksums reject paths, duplicates, and missing packages", async () => {
  const { parseChecksumFile } = await import(moduleUrl);
  const chrome = "humble-helper-1.2.3-chrome.zip";
  const firefox = "humble-helper-1.2.3-firefox.zip";
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const parsed = parseChecksumFile(
    `${hashA}  ${chrome}\n${hashB}  ${firefox}\n`,
    [chrome, firefox]
  );
  assert.equal(parsed.get(chrome), hashA);
  assert.throws(() => parseChecksumFile(`${hashA}  ../${chrome}\n`, [chrome, firefox]));
  assert.throws(() => parseChecksumFile(`${hashA}  ${chrome}\n${hashB}  ${chrome}\n`, [chrome, firefox]));
  assert.throws(() => parseChecksumFile(`${hashA}  ${chrome}\n`, [chrome, firefox]));
});

test("immutable release validation uses the tagged source base rather than current main or ambient overrides", async () => {
  const { validateReleasedSourceMetadata } = await import(moduleUrl);
  const sourceManifest = {
    version: "0.2.0", manifest_version: 3,
    browser_specific_settings: { gecko: { id: "humble-steam-filter@example.com" } }
  };
  assert.equal(validateReleasedSourceMetadata("v0.2.1", { version: "0.2.0" }, sourceManifest).manifest, sourceManifest);
  assert.throws(() => validateReleasedSourceMetadata("v0.2.1", { version: "0.3.0" }, { ...sourceManifest, version: "0.3.0" }), /source major\/minor/);
  assert.throws(() => validateReleasedSourceMetadata("v0.2.1", { version: "0.2.0" }, { ...sourceManifest, version: "0.2.1" }), /must match/);
  assert.throws(() => validateReleasedSourceMetadata("v0.2.1", { version: "0.2.0" }, { ...sourceManifest, browser_specific_settings: {} }), /Firefox extension ID/);
});

test("released ZIP manifests must match the immutable version, browser schema, and extension identity", async () => {
  const { validateReleasedManifest } = await import(moduleUrl);
  const sourceManifest = {
    version: "0.2.0", manifest_version: 3,
    browser_specific_settings: { gecko: { id: "humble-steam-filter@example.com" } }
  };
  const firefoxManifest = { ...sourceManifest, version: "0.2.1" };
  const chromeManifest = { version: "0.2.1", manifest_version: 3 };
  validateReleasedManifest({ tag: "v0.2.1", browser: "firefox", manifest: firefoxManifest, sourceManifest });
  validateReleasedManifest({ tag: "v0.2.1", browser: "chrome", manifest: chromeManifest, sourceManifest });
  for (const manifest of [
    { ...firefoxManifest, version: "0.2.0" },
    { ...firefoxManifest, manifest_version: 2 },
    { ...firefoxManifest, browser_specific_settings: { gecko: { id: "another@example.com" } } },
    { ...firefoxManifest, browser_specific_settings: {} },
    [], null
  ]) assert.throws(() => validateReleasedManifest({ tag: "v0.2.1", browser: "firefox", manifest, sourceManifest }));
  assert.throws(() => validateReleasedManifest({ tag: "v0.2.1", browser: "chrome", manifest: firefoxManifest, sourceManifest }), /extension ID/);
});

test("release verifier source-ref arguments bind old-asset validation to that exact release tag", async () => {
  const { parseReleaseArtifactArguments, assertRepositoryVersionAtRef } = await import(moduleUrl);
  assert.deepEqual(parseReleaseArtifactArguments(["prepare", "--", "v0.2.1"]), { command: "prepare", tag: "v0.2.1" });
  assert.deepEqual(parseReleaseArtifactArguments(["verify", "v0.2.1", "release-artifacts", "firefox", "--source-ref", "v0.2.1"]), {
    command: "verify", tag: "v0.2.1", directory: "release-artifacts", target: "firefox", sourceRef: "v0.2.1"
  });
  for (const arguments_ of [
    ["prepare", "v0.2.1", "extra"],
    ["verify", "v0.2.1", "--source-ref"],
    ["verify", "v0.2.1", "--source-ref", "main"],
    ["verify", "v0.2.1", "--source-ref", "v0.2.2"],
    ["verify", "v0.2.1", "--source-ref", "v0.2.1", "--source-ref", "v0.2.1"],
    ["verify", "v0.2.1", "release-artifacts", "safari"],
    ["verify", "v0.2.1", "release-artifacts", "firefox", "unexpected"]
  ]) assert.throws(() => parseReleaseArtifactArguments(arguments_));
  await assert.rejects(() => assertRepositoryVersionAtRef("v0.2.1", "main"), /exact release tag/);
});
