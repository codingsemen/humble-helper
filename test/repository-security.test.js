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
  assert.match(ci, /pnpm run audit:release/);
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

test("locks the patched web-ext transitive security overrides", () => {
  const lockfile = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  assert.match(lockfile, /adm-zip: 0\.6\.1/);
  assert.match(lockfile, /shell-quote: 1\.12\.0/);
  assert.doesNotMatch(lockfile, /^\s{2}adm-zip@(?:0\.5\.\d+|0\.6\.0):/m);
  assert.doesNotMatch(lockfile, /^\s{2}shell-quote@1\.(?:8|9|10)\.\d+:/m);
});

test("publishes only successful CI pushes to main from this repository", () => {
  const source = fs.readFileSync(path.join(root, ".github", "workflows", "release-main.yml"), "utf8");
  assert.match(source, /workflow_run:/);
  assert.match(source, /workflows: \[CI\]/);
  assert.match(source, /workflow_run\.conclusion == 'success'/);
  assert.match(source, /workflow_run\.event == 'push'/);
  assert.match(source, /workflow_run\.head_branch == 'main'/);
  assert.match(source, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(source, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(source, /pnpm run audit:release/);
  assert.match(source, /HUMBLE_RELEASE_VERSION:/);
  assert.match(source, /secrets: inherit/);
  assert.match(source, /needs\.source\.outputs\.current == 'true'/);
  assert.match(source, /CURRENT_MAIN=/);
  assert.match(source, /needs: \[build, amo-preflight\]/);
  assert.match(source, /--allow-existing "\$REUSED"/);
  assert.match(source, /--verify-tag/);
  assert.match(source, /\$OBJECT_SHA" != "\$SOURCE_SHA/);
  assert.match(source, /needs\.github-release\.outputs\.published == 'true'/);
  assert.doesNotMatch(source, /pull_request_target/);
});

test("serializes automatic and manual release versions without canceling pending store jobs", () => {
  for (const file of ["release-main.yml", "release.yml", "publish-stores.yml"]) {
    const source = fs.readFileSync(path.join(root, ".github", "workflows", file), "utf8");
    assert.match(source, /concurrency:\s*\n\s*group: (?:extension-release|store-publish)\s*\n\s*cancel-in-progress: false\s*\n\s*queue: max/);
  }
});
