const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "release-version.mjs"));

test("automatic patches advance beyond both repository releases and manual AMO uploads", async () => {
  const { selectAutomaticReleaseVersion } = await import(moduleUrl);
  assert.equal(selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.1.25", "v0.2.8", "v0.2.10", "documentation", "v0.3.0-beta"],
    amoVersion: "0.2.12"
  }), "0.2.13");
  assert.equal(selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.2.15"],
    amoVersion: "0.2.12"
  }), "0.2.16");
});

test("manual source patch and major/minor changes define the next automatic release", async () => {
  const { selectAutomaticReleaseVersion } = await import(moduleUrl);
  assert.equal(selectAutomaticReleaseVersion({
    sourceVersion: "0.2.20",
    tags: ["v0.2.15"],
    amoVersion: "0.2.12"
  }), "0.2.21");
  assert.equal(selectAutomaticReleaseVersion({
    sourceVersion: "0.3.0",
    tags: ["v0.2.25"],
    amoVersion: "0.2.25"
  }), "0.3.1");
  assert.equal(selectAutomaticReleaseVersion({
    sourceVersion: "1.0.0",
    tags: ["v0.99.25"],
    amoVersion: "0.99.25"
  }), "1.0.1");
});

test("version selection refuses a stale source line that would downgrade published releases", async () => {
  const { selectAutomaticReleaseVersion } = await import(moduleUrl);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.3.1"],
    amoVersion: "0.2.12"
  }), /would downgrade/);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.2.12"],
    amoVersion: "1.0.1"
  }), /would downgrade/);
});

test("a retry reuses the release already reserved for its exact commit", async () => {
  const { selectAutomaticReleaseVersion } = await import(moduleUrl);
  const input = {
    sourceVersion: "0.2.0",
    tags: ["v0.2.11", "v0.2.12"],
    headTags: ["v0.2.12"],
    amoVersion: "0.2.11"
  };
  assert.equal(selectAutomaticReleaseVersion(input), "0.2.12");
  assert.equal(selectAutomaticReleaseVersion({ ...input, amoVersion: "0.2.12" }), "0.2.12");
  assert.equal(selectAutomaticReleaseVersion({ ...input, headTags: [] }), "0.2.13");
});

test("release outputs distinguish a new allocation from an existing tag at HEAD", async () => {
  const { automaticReleaseOutputs } = await import(moduleUrl);
  const input = {
    sourceVersion: "0.2.0",
    tags: ["v0.2.11", "v0.2.12"],
    amoVersion: "0.2.11"
  };
  assert.deepEqual(automaticReleaseOutputs(input), { version: "0.2.13", tag: "v0.2.13", reused: false });
  assert.deepEqual(automaticReleaseOutputs({ ...input, headTags: ["v0.2.12"] }), {
    version: "0.2.12", tag: "v0.2.12", reused: true
  });
  assert.deepEqual(automaticReleaseOutputs({ ...input, headTags: ["documentation", "v0.1.25"] }), {
    version: "0.2.13", tag: "v0.2.13", reused: false
  });
});

test("ambiguous and superseded retries fail instead of allocating or publishing another version", async () => {
  const { selectAutomaticReleaseVersion } = await import(moduleUrl);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.2.11", "v0.2.12"],
    headTags: ["v0.2.11", "v0.2.12"],
    amoVersion: "0.2.11"
  }), /multiple release version tags/);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.2.12", "v0.2.13"],
    headTags: ["v0.2.12"],
    amoVersion: "0.2.12"
  }), /superseded/);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.2.12"],
    headTags: ["v0.2.12"],
    amoVersion: "0.2.13"
  }), /superseded/);
});

test("patch exhaustion requires an intentional source major/minor increment", async () => {
  const { selectAutomaticReleaseVersion } = await import(moduleUrl);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.65535"
  }), /patch versions are exhausted/);
  assert.throws(() => selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    amoVersion: "0.2.65535"
  }), /patch versions are exhausted/);
  assert.equal(selectAutomaticReleaseVersion({
    sourceVersion: "0.2.0",
    tags: ["v0.2.65535"],
    headTags: ["v0.2.65535"],
    amoVersion: "0.2.65535"
  }), "0.2.65535");
});

test("packaging overrides preserve the source release line and cannot downgrade its patch", async () => {
  const { effectiveReleaseVersion } = await import(moduleUrl);
  assert.equal(effectiveReleaseVersion("0.2.0", "0.2.0", "0.2.12"), "0.2.12");
  assert.equal(effectiveReleaseVersion("0.2.0", "0.2.0", "0.2.0"), "0.2.0");
  assert.throws(() => effectiveReleaseVersion("0.2.0", "0.2.1", "0.2.12"), /versions must match/);
  for (const override of ["0.1.9", "0.3.1", "1.0.1"]) {
    assert.throws(() => effectiveReleaseVersion("0.2.0", "0.2.0", override), /source major\/minor/);
  }
  assert.throws(() => effectiveReleaseVersion("0.2.12", "0.2.12", "0.2.11"), /equal or newer patch/);
});

test("the default packaging version honors HUMBLE_RELEASE_VERSION only when configured", async () => {
  const { effectiveReleaseVersion } = await import(moduleUrl);
  const previous = process.env.HUMBLE_RELEASE_VERSION;
  try {
    delete process.env.HUMBLE_RELEASE_VERSION;
    assert.equal(effectiveReleaseVersion("0.2.0", "0.2.0"), "0.2.0");
    process.env.HUMBLE_RELEASE_VERSION = "0.2.15";
    assert.equal(effectiveReleaseVersion("0.2.0", "0.2.0"), "0.2.15");
  } finally {
    if (previous === undefined) {
      delete process.env.HUMBLE_RELEASE_VERSION;
    } else {
      process.env.HUMBLE_RELEASE_VERSION = previous;
    }
  }
});

test("all version inputs obey canonical Chrome-compatible numeric limits", async () => {
  const { assertReleaseVersion, effectiveReleaseVersion, selectAutomaticReleaseVersion } = await import(moduleUrl);
  assert.equal(assertReleaseVersion("65535.65535.65535"), "65535.65535.65535");
  assert.equal(assertReleaseVersion("0.0.1"), "0.0.1");
  for (const invalid of [null, 1, "", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-beta", "0.0.0", "65536.1.1", "1.2.65536", "1.2.3\n"]) {
    assert.throws(() => assertReleaseVersion(invalid));
    assert.throws(() => effectiveReleaseVersion("0.2.0", "0.2.0", invalid));
    assert.throws(() => selectAutomaticReleaseVersion({ sourceVersion: invalid }));
  }
  assert.throws(() => selectAutomaticReleaseVersion({ sourceVersion: "0.2.0", tags: ["v0.2.65536"] }));
  assert.throws(() => selectAutomaticReleaseVersion({ sourceVersion: "0.2.0", amoVersion: "0.2.01" }));
});

test("AMO lookup uses the exact Gecko ID and a bounded public request", async () => {
  const { fetchPublicAmoVersion } = await import(moduleUrl);
  const guid = "humble-steam-filter@example.com";
  const version = await fetchPublicAmoVersion(guid, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://addons.mozilla.org/api/v5/addons/addon/humble-steam-filter%40example.com/");
      assert.equal(options.headers.Accept, "application/json");
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ guid, current_version: { version: "0.2.12" } }) };
    }
  });
  assert.equal(version, "0.2.12");
});

test("AMO errors or incomplete responses stop selection instead of guessing a patch", async () => {
  const { fetchPublicAmoVersion } = await import(moduleUrl);
  const guid = "humble-steam-filter@example.com";
  for (const status of [401, 404, 429, 500]) {
    await assert.rejects(fetchPublicAmoVersion(guid, {
      fetchImpl: async () => ({ ok: false, status })
    }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(fetchPublicAmoVersion(guid, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ guid: "other@example.com", current_version: { version: "0.2.12" } }) })
  }), /different extension ID/);
  await assert.rejects(fetchPublicAmoVersion(guid, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ guid, current_version: null }) })
  }), /no public current version/);
  await assert.rejects(fetchPublicAmoVersion(guid, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ guid, current_version: { version: "0.2.beta" } }) })
  }), /MAJOR.MINOR.PATCH/);
});
