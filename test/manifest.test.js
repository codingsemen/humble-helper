const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const manifest = JSON.parse(fs.readFileSync(require.resolve("../manifest.json"), "utf8"));

test("uses least-privilege extension permissions", () => {
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://*.humblebundle.com/*",
    "https://store.steampowered.com/*"
  ]);
  assert.equal("externally_connectable" in manifest, false);
});

test("injects both content scripts on localized Humble bundle pages", () => {
  const expectedMatches = [
    "https://*.humblebundle.com/games/*",
    "https://*.humblebundle.com/books/*",
    "https://*.humblebundle.com/software/*"
  ];
  assert.equal(manifest.content_scripts.length, 2);
  for (const contentScript of manifest.content_scripts) {
    assert.deepEqual(contentScript.matches, expectedMatches);
  }
});

test("declares an explicit extension-page content security policy", () => {
  const policy = manifest.content_security_policy.extension_pages;
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /connect-src https:\/\/humblebundle\.com https:\/\/\*\.humblebundle\.com https:\/\/store\.steampowered\.com/);
  assert.match(policy, /img-src 'self' https:\/\/hb\.imgix\.net https:\/\/humblebundle-a\.akamaihd\.net/);
  assert.doesNotMatch(policy, /https:\/\/\*(?:[;\s]|$)/);
});
