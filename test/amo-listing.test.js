const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const moduleUrl = pathToFileURL(path.join(root, "scripts", "sync-amo-listing.mjs"));

function response(status, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    }
  };
}

test("validates the repository-managed Firefox listing and keeps API fields separate from assets", async () => {
  const listing = JSON.parse(fs.readFileSync(path.join(root, "store", "firefox", "listing.json"), "utf8"));
  const { buildMetadataPayload, buildSubmissionMetadata, validateListing } = await import(moduleUrl);
  assert.equal(validateListing(listing), listing);
  const metadata = buildMetadataPayload(listing);
  assert.equal(metadata.default_locale, "en-US");
  assert.equal(metadata.name["en-US"], "Humble Helper - Bundle & Steam Companion");
  assert.equal("icon" in metadata, false);
  assert.equal("previews" in metadata, false);
  assert.deepEqual(buildSubmissionMetadata(listing), {
    summary: listing.metadata.summary,
    categories: ["other"],
    version: { license: "MIT" }
  });
});

test("creates a short-lived AMO JWT with the expected claims and signature", async () => {
  const { createJwt } = await import(moduleUrl);
  const issuer = "user:123:456";
  const secret = "test-secret";
  const issuedAt = 1_700_000_000;
  const token = createJwt(issuer, secret, issuedAt);
  const [headerPart, payloadPart, signature] = token.split(".");
  const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  const header = decode(headerPart);
  const payload = decode(payloadPart);
  const expected = crypto.createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");

  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
  assert.equal(payload.iss, issuer);
  assert.equal(payload.iat, issuedAt);
  assert.equal(payload.exp, issuedAt + 300);
  assert.equal(signature, expected);
});

test("synchronizes metadata, icon, and the exact repository preview set", async () => {
  const calls = [];
  let nextPreviewId = 100;
  const { syncAmoListing } = await import(moduleUrl);
  const result = await syncAmoListing({
    issuer: "user:test:1",
    secret: "test-secret",
    version: "0.2.0",
    apiBaseUrl: "https://amo.test/api/v5",
    fetchImpl: async (url, options = {}) => {
      const parsedUrl = new URL(url);
      calls.push({ url: parsedUrl, options });
      const method = options.method || "GET";
      if (method === "GET") {
        return response(200, JSON.stringify({ previews: [{ id: 11 }, { id: 12 }] }));
      }
      if (method === "DELETE") {
        return response(204);
      }
      if (method === "POST" && parsedUrl.pathname.endsWith("/previews/")) {
        return response(201, JSON.stringify({ id: nextPreviewId++ }));
      }
      return response(200, "{}");
    }
  });

  assert.equal(result.guid, "humble-steam-filter@example.com");
  assert.equal(result.previewCount, 4);
  assert.equal(result.dryRun, false);
  assert.equal(calls.filter(({ options }) => (options.method || "GET") === "GET").length, 1);
  assert.equal(calls.filter(({ options }) => options.method === "DELETE").length, 2);
  assert.equal(calls.filter(({ options }) => options.method === "POST").length, 4);
  assert.equal(calls.filter(({ options }) => options.method === "PATCH").length, 6);

  for (const { options } of calls) {
    assert.match(options.headers.Authorization, /^JWT [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(options.headers.Authorization, /test-secret/);
  }
});
