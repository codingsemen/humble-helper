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
