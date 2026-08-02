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
  assert.match(release, /ENABLE_STORE_PUBLISHING == 'true'/);
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

test("locks the audited web-ext transitive security overrides", () => {
  const lockfile = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  assert.match(lockfile, /adm-zip: 0\.6\.0/);
  assert.match(lockfile, /shell-quote: 1\.9\.0/);
  assert.doesNotMatch(lockfile, /^\s{2}adm-zip@0\.5\./m);
  assert.doesNotMatch(lockfile, /^\s{2}shell-quote@1\.8\.4:/m);
});
