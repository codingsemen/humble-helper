const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "run-amo-listing-sync.mjs"));
const guid = "humble-steam-filter@example.com";

function response(status, payload = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; },
    async text() { return status === 204 ? "" : JSON.stringify(payload); }
  };
}

function mockAmo({ currentVersion = "0.2.1", versionStatus = "public", versionExists = true } = {}) {
  const calls = [];
  let nextPreviewId = 100;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method || "GET";
    calls.push({ pathname, method, options });
    if (method === "GET" && pathname.includes("/versions/")) {
      const version = /\/versions\/v([^/]+)\//.exec(pathname)[1];
      return versionExists
        ? response(200, { version, channel: "listed", is_disabled: false, file: { status: versionStatus } })
        : response(404);
    }
    if (method === "GET") {
      return response(200, { guid, current_version: { version: currentVersion }, default_locale: "en-US", previews: [] });
    }
    if (method === "POST") return response(201, { id: nextPreviewId++ });
    return response(method === "DELETE" ? 204 : 200);
  };
  return { calls, fetchImpl };
}

test("standalone listing sync targets the existing public version, not the source manifest version", async () => {
  const { syncCurrentAmoListing } = await import(moduleUrl);
  const { calls, fetchImpl } = mockAmo();
  const result = await syncCurrentAmoListing({ issuer: "user:test:1", secret: "secret", fetchImpl });
  assert.equal(result.version, "0.2.1");
  assert.equal(result.dryRun, false);
  assert.equal(calls[0].options.headers.Authorization, undefined, "current-version lookup is public");
  assert.match(calls[1].pathname, /\/versions\/v0\.2\.1\/$/);
  assert.match(calls[1].options.headers.Authorization, /^JWT /);
  assert.equal(calls.filter(({ method }) => method === "POST").length, 4, "only existing listing previews are uploaded");
  assert.ok(calls.every(({ pathname }) => !pathname.includes("/uploads/")), "listing sync never uploads extension code");
});

test("explicit listing target permits an already-submitted listed version awaiting review", async () => {
  const { syncCurrentAmoListing } = await import(moduleUrl);
  const { calls, fetchImpl } = mockAmo({ versionStatus: "unreviewed" });
  const result = await syncCurrentAmoListing({ version: "0.2.2", issuer: "user:test:1", secret: "secret", fetchImpl });
  assert.equal(result.version, "0.2.2");
  assert.match(calls[0].pathname, /\/versions\/v0\.2\.2\/$/, "explicit targets skip public-version lookup");
});

test("missing or unusable AMO target versions fail before any listing write", async () => {
  const { syncCurrentAmoListing } = await import(moduleUrl);
  for (const options of [{ versionExists: false }, { versionStatus: "disabled" }, { versionStatus: "rejected" }]) {
    const { calls, fetchImpl } = mockAmo(options);
    await assert.rejects(() => syncCurrentAmoListing({ version: "0.2.1", issuer: "user:test:1", secret: "secret", fetchImpl }));
    assert.ok(calls.every(({ method }) => method === "GET"));
  }
});

test("standalone dry-run validates local listing assets without credentials or network", async () => {
  const { syncCurrentAmoListing } = await import(moduleUrl);
  const result = await syncCurrentAmoListing({ dryRun: true, fetchImpl: () => assert.fail("dry-run must stay offline") });
  assert.equal(result.dryRun, true);
  assert.equal(result.version, null);
  assert.equal(result.previewCount, 4);
});

test("listing sync CLI rejects ambiguous or noncanonical version inputs", async () => {
  const { parseListingSyncArguments } = await import(moduleUrl);
  assert.deepEqual(parseListingSyncArguments([]), { dryRun: false });
  assert.deepEqual(parseListingSyncArguments(["--", "--dry-run"]), { dryRun: true });
  assert.deepEqual(parseListingSyncArguments(["--version", "0.2.1", "--dry-run"]), { dryRun: true, version: "0.2.1" });
  for (const arguments_ of [
    ["--version"], ["--version", "v0.2.1"], ["--version", "00.2.1"],
    ["--version", "0.2.1", "--version", "0.2.2"], ["--dry-run", "--dry-run"], ["--unknown"]
  ]) assert.throws(() => parseListingSyncArguments(arguments_));
});
