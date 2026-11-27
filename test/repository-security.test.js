const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("pins every external GitHub Action to an immutable commit", () => {
  const workflowDirectory = path.join(root, ".github", "workflows");
  const workflowFiles = fs.readdirSync(workflowDirectory).filter((file) => file.endsWith(".yml"));
  let actionCount = 0;

  for (const file of workflowFiles) {
    const source = fs.readFileSync(path.join(workflowDirectory, file), "utf8");
    for (const match of source.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
      actionCount += 1;
      assert.match(match[2], /^[0-9a-f]{40}$/, `${file}: ${match[1]} is not pinned to a full commit`);
    }
  }

  assert.ok(actionCount > 0);
});

test("tests pull request branch heads without privileged pull_request_target execution", () => {
  const source = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(source, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(source, /github\.event\.pull_request\.head\.sha/);
  assert.match(source, /permissions:\s*\n\s*contents: read/);
  assert.match(source, /persist-credentials: false/);
  assert.doesNotMatch(source, /pull_request_target/);
  assert.doesNotMatch(source, /secrets\./);
});

test("keeps dependency audits scheduled and release handoff storage short-lived", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const security = fs.readFileSync(path.join(root, ".github", "workflows", "security.yml"), "utf8");
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.doesNotMatch(ci, /upload-artifact/);
  assert.doesNotMatch(ci, /pnpm (?:run )?audit/);
  assert.match(security, /cron: "17 4 \* \* 3"/);
  assert.match(security, /pnpm audit --audit-level high/);
  assert.match(release, /retention-days: 1/);
  assert.match(release, /--generate-notes/);
  assert.match(release, /ENABLE_FIREFOX_PUBLISHING == 'true'/);
  assert.match(release, /ENABLE_CHROME_PUBLISHING == 'true'/);
  assert.match(release, /target: firefox/);
  assert.match(release, /target: chrome/);
  assert.doesNotMatch(release, /ENABLE_STORE_PUBLISHING/);
});

test("uses gated short-lived Chrome credentials and no legacy OAuth secret", () => {
  const source = fs.readFileSync(
    path.join(root, ".github", "workflows", "publish-stores.yml"),
    "utf8"
  );
  assert.match(source, /environment: browser-stores/g);
  assert.match(source, /id-token: write/);
  assert.match(source, /google-github-actions\/auth@[0-9a-f]{40}/);
  assert.match(source, /access_token_lifetime: 600s/);
  assert.match(source, /create_credentials_file: false/);
  assert.doesNotMatch(source, /CHROME_(?:CLIENT_SECRET|REFRESH_TOKEN)/);
  assert.doesNotMatch(source, /credentials_json/);
});

test("keeps Firefox listing synchronization behind the AMO environment", () => {
  const source = fs.readFileSync(
    path.join(root, ".github", "workflows", "publish-stores.yml"),
    "utf8"
  );
  assert.match(source, /firefox-listing:/);
  assert.match(source, /needs: firefox/);
  assert.match(source, /node scripts\/sync-amo-listing\.mjs --version/);
  assert.match(source, /AMO_JWT_ISSUER: \$\{\{ secrets\.AMO_JWT_ISSUER \}\}/);
  assert.match(source, /AMO_JWT_SECRET: \$\{\{ secrets\.AMO_JWT_SECRET \}\}/);
});

test("keeps package and extension versions aligned", () => {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(packageMetadata.version, manifest.version);
});

test("runs the packaging CLI without an intermediate command shell", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "build-extensions.mjs"), "utf8");
  assert.match(source, /spawn\(process\.execPath/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /shell:\s*true/);
});

test("uses a shell-free, repository-wide JavaScript syntax check", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "check-syntax.mjs"), "utf8");
  assert.match(source, /spawn\(process\.execPath/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /shell:\s*true/);
});

test("locks patched versions of previously vulnerable build dependencies", () => {
  const lockfile = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  // Minimum patched releases from the 2026-11-19 audit. This guards against
  // restoring old pins; the scheduled audit still checks for new advisories.
  const minimums = {
    "adm-zip": "0.6.1",
    "brace-expansion": "1.1.21",
    "fast-uri": "3.1.9",
    "image-size": "2.0.3",
    "js-yaml": "4.3.2",
    "node-forge": "1.4.3",
    "shell-quote": "1.11.0",
    "source-map-js": "1.2.2",
    undici: "7.30.1"
  };
  for (const [name, minimum] of Object.entries(minimums)) {
    const versions = [...lockfile.matchAll(new RegExp(`^  ${name}@(\\d+\\.\\d+\\.\\d+):`, "gm"))];
    assert.ok(versions.length, `${name} must be checked in the lockfile`);
    const floor = minimum.split(".").map(Number);
    for (const [, version] of versions) {
      const parts = version.split(".").map(Number);
      const different = parts.findIndex((part, index) => part !== floor[index]);
      assert.ok(different === -1 || parts[different] > floor[different], `${name}@${version} is older than patched ${minimum}`);
    }
  }
});
