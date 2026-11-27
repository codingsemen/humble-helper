const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "check-amo-version.mjs"));

test("avoids duplicate AMO submissions for public or pending versions", async () => {
  const { amoVersionExists } = await import(moduleUrl);
  for (const status of ["public", "unreviewed"]) {
    assert.equal(await amoVersionExists({
      guid: "test@example.com", version: "0.2.1", issuer: "test", secret: "test",
      fetchImpl: async (url, options) => {
        assert.match(url, /test%40example\.com\/versions\/v0\.2\.1\/$/);
        assert.match(options.headers.Authorization, /^JWT /);
        return { ok: true, json: async () => ({ version: "0.2.1", channel: "listed", is_disabled: false, file: { status } }) };
      }
    }), true);
  }
});

test("only a missing AMO version allows a fresh submission", async () => {
  const { amoVersionExists } = await import(moduleUrl);
  const options = { guid: "test@example.com", version: "0.2.1", issuer: "test", secret: "test" };
  assert.equal(await amoVersionExists({ ...options, fetchImpl: async () => ({ status: 404 }) }), false);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(amoVersionExists({ ...options, fetchImpl: async () => ({ status, ok: false }) }), /HTTP/);
  }
  for (const payload of [
    { version: "0.2.1", channel: "listed", file: { status: "disabled" } },
    { version: "0.2.1", channel: "listed", file: { status: "rejected" } },
    { version: "0.2.1", channel: "unlisted", file: { status: "public" } },
    { version: "0.2.1", channel: "listed", is_disabled: true, file: { status: "public" } },
    { version: "0.2.1", file: { status: "public" } },
    { version: "0.2.0", file: { status: "public" } },
    { version: "0.2.1" }
  ]) {
    await assert.rejects(amoVersionExists({
      ...options,
      fetchImpl: async () => ({ ok: true, json: async () => payload })
    }));
  }
});

test("new automatic releases reject occupied listed versions instead of silently treating them as retries", async () => {
  const { amoVersionExists } = await import(moduleUrl);
  const options = { guid: "test@example.com", version: "0.2.1", issuer: "test", secret: "test", allowExisting: false };
  assert.equal(await amoVersionExists({ ...options, fetchImpl: async () => ({ status: 404 }) }), false);
  for (const status of ["public", "unreviewed"]) {
    await assert.rejects(amoVersionExists({
      ...options,
      fetchImpl: async () => ({ ok: true, json: async () => ({
        version: "0.2.1", channel: "listed", is_disabled: false, file: { status }
      }) })
    }), /already occupied.*version collision.*developer dashboard/);
  }
  await assert.rejects(amoVersionExists({ ...options, allowExisting: "false" }), /must be a boolean/);
});

test("AMO CLI accepts an explicit retry policy and rejects ambiguous or invalid options", async () => {
  const { parseAmoVersionArguments } = await import(moduleUrl);
  assert.deepEqual(parseAmoVersionArguments(["v0.2.1"]), { version: "0.2.1", allowExisting: true });
  assert.deepEqual(parseAmoVersionArguments(["v0.2.1", "--require-new"]), { version: "0.2.1", allowExisting: false });
  assert.deepEqual(parseAmoVersionArguments(["v0.2.1", "--allow-existing", "true"]), { version: "0.2.1", allowExisting: true });
  assert.deepEqual(parseAmoVersionArguments(["v0.2.1", "--allow-existing", "false"]), { version: "0.2.1", allowExisting: false });
  assert.deepEqual(parseAmoVersionArguments(["v0.2.1", "--allow-existing=false"]), { version: "0.2.1", allowExisting: false });
  for (const options of [
    ["--allow-existing"], ["--allow-existing", "yes"], ["--allow-existing=false", "--require-new"],
    ["--require-new", "true"], ["--allow-existing=FALSE"], ["--unknown"]
  ]) {
    assert.throws(() => parseAmoVersionArguments(["v0.2.1", ...options]), /Usage:/);
  }
});
