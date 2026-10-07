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

test("changing AMO default locale preserves existing contact translations and unwraps outgoing URLs", async () => {
  const listing = JSON.parse(fs.readFileSync(path.join(root, "store", "firefox", "listing.json"), "utf8"));
  const { buildMetadataPayload } = await import(moduleUrl);
  const addon = {
    default_locale: "de",
    support_email: { de: "maintainer@example.com", fr: "assistance@example.com" },
    support_url: {
      url: { de: "https://example.com/support" },
      outgoing: { de: "https://outgoing.example/redirect" }
    },
    developer_comments: { de: "Existing reviewer notes" }
  };
  const original = structuredClone(addon);
  const metadata = buildMetadataPayload(listing, addon);
  assert.deepEqual(metadata.support_email, { ...addon.support_email, "en-US": "maintainer@example.com" });
  assert.deepEqual(metadata.support_url, { de: "https://example.com/support", "en-US": "https://example.com/support" });
  assert.equal(metadata.developer_comments["en-US"], "Existing reviewer notes");
  assert.equal(metadata.name["en-US"], listing.metadata.name["en-US"]);
  assert.deepEqual(addon, original);
  assert.equal("support_email" in listing.metadata, false);
});

test("AMO locale migration preserves existing target values and honors explicit repository support fields", async () => {
  const listing = JSON.parse(fs.readFileSync(path.join(root, "store", "firefox", "listing.json"), "utf8"));
  const { buildMetadataPayload, validateListing } = await import(moduleUrl);
  const addon = {
    default_locale: "de",
    support_email: { de: "de@example.com", "en-US": "english@example.com" },
    support_url: { url: { de: "https://example.com/de", "en-US": "https://example.com/en" } }
  };
  const metadata = buildMetadataPayload(listing, addon);
  assert.equal("support_email" in metadata, false);
  assert.equal("support_url" in metadata, false);
  const explicit = structuredClone(listing);
  explicit.metadata.support_email = { "en-US": "configured@example.com" };
  explicit.metadata.support_url = { "en-US": "https://example.com/configured" };
  assert.equal(validateListing(explicit), explicit);
  const explicitPayload = buildMetadataPayload(explicit, addon);
  assert.deepEqual(explicitPayload.support_email, explicit.metadata.support_email);
  assert.deepEqual(explicitPayload.support_url, explicit.metadata.support_url);
  assert.deepEqual(buildMetadataPayload(listing, { ...addon, default_locale: "en-US" }), buildMetadataPayload(listing));
});

test("AMO locale migration skips empty optional fields and fails before writes on ambiguous existing translations", async () => {
  const listing = JSON.parse(fs.readFileSync(path.join(root, "store", "firefox", "listing.json"), "utf8"));
  const { buildMetadataPayload, validateListing } = await import(moduleUrl);
  assert.deepEqual(buildMetadataPayload(listing, {
    default_locale: "de", support_email: null, support_url: { url: {} }, developer_comments: { de: null }
  }), buildMetadataPayload(listing));
  for (const addon of [
    {},
    { default_locale: "de", developer_comments: { de: "" } },
    { default_locale: "de", support_email: { fr: "contact@example.com" } },
    { default_locale: "de", support_email: "contact@example.com" },
    { default_locale: "de", support_email: { de: 12 } },
    { default_locale: "de", support_url: { outgoing: { de: "https://outgoing.example/" } } }
  ]) assert.throws(() => buildMetadataPayload(listing, addon));
  const invalidListing = structuredClone(listing);
  invalidListing.metadata.support_url = { de: "https://example.com/" };
  assert.throws(() => validateListing(invalidListing), /default locale en-US/);
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
        assert.equal(parsedUrl.search, "", "fetch full translations, never ?lang=en-US");
        return response(200, JSON.stringify({
          default_locale: "de",
          support_email: { de: "maintainer@example.com" },
          support_url: { url: { de: "https://example.com/support" }, outgoing: { de: "https://outgoing.example/" } },
          previews: [{ id: 11 }, { id: 12 }]
        }));
      }
      if (method === "PATCH" && options.headers["Content-Type"] === "application/json"
        && parsedUrl.pathname.endsWith("/addon/humble-steam-filter%40example.com/")) {
        const metadata = JSON.parse(options.body);
        // Model AMO's real default-locale validator; the previous payload
        // failed here before reaching icon or preview uploads.
        if (!metadata.support_email?.[metadata.default_locale] || !metadata.support_url?.[metadata.default_locale]) {
          return response(400, JSON.stringify({ support_email: ["Default locale required"], support_url: ["Default locale required"] }));
        }
        assert.equal(metadata.support_email["en-US"], "maintainer@example.com");
        assert.equal(metadata.support_url["en-US"], "https://example.com/support");
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
