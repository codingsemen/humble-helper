const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "release-changes.mjs"));
const head = "a".repeat(40);
const baseline = "b".repeat(40);
const release = (tagName) => ({ tagName });

function mocked(options = {}) {
  const calls = [];
  return {
    calls,
    options: {
      githubRepo: "owner/repo", token: "test-token", sourceSha: head,
      readReleases: async () => [release("v0.2.1")],
      gitImpl: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse") return `${args[1] === "HEAD" ? head : baseline}\n`;
        if (args[0] === "merge-base") return "";
        if (args[0] === "diff") return "README.md\0";
        assert.fail(`Unexpected git command: ${args.join(" ")}`);
      },
      ...options
    }
  };
}

test("release paths include every shipped source and explicit packaging scripts", async () => {
  const { hasExtensionChanges } = await import(moduleUrl);
  for (const file of ["background.js", "shared.js", "popup.html", "popup.css", "popup.js",
    "options.html", "options.css", "options.js", "manifest.json", "content/nested/game.js",
    "icons/icon-128.png", "scripts/prepare-build.mjs", "scripts/build-extensions.mjs"]) {
    assert.equal(hasExtensionChanges([file]), true, file);
  }
  assert.equal(hasExtensionChanges([]), false);
  assert.equal(hasExtensionChanges(["README.md", "publish.md", "test/helper.test.js", "package.json",
    "pnpm-lock.yaml", ".github/workflows/release-main.yml", "scripts/sync-amo-listing.mjs",
    "scripts/release-changes.mjs", "scripts/publish-chrome.mjs", "store/firefox/listing.json",
    "store/chrome/screenshots/01.png", "content-not-shipped.js", "icons-not-shipped.png"]), false);
  assert.throws(() => hasExtensionChanges([null]), /paths must be strings/);
});

test("path policy remains aligned with the explicit prepared extension source entries", async () => {
  const { hasExtensionChanges } = await import(moduleUrl);
  const script = await readFile(path.resolve(__dirname, "..", "scripts", "prepare-build.mjs"), "utf8");
  const entries = [...script.match(/const sourceEntries = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  for (const entry of entries) {
    assert.equal(hasExtensionChanges([entry.includes(".") ? entry : `${entry}/fixture.js`]), true, entry);
  }
});

test("published baseline uses highest canonical stable version rather than GitHub date order", async () => {
  const { selectPublishedReleaseTag } = await import(moduleUrl);
  assert.equal(selectPublishedReleaseTag([release("v0.2.9"), release("v0.2.10"), release("v00.3.0"),
    release("v1.0.0-beta"), release("docs-2026")]), "v0.2.10");
  assert.equal(selectPublishedReleaseTag([]), "");
  assert.equal(selectPublishedReleaseTag([release("docs-2026")]), "");
  assert.throws(() => selectPublishedReleaseTag([{}]), /invalid release/);
  assert.throws(() => selectPublishedReleaseTag({}), /must be an array/);
  assert.throws(() => selectPublishedReleaseTag([release("v0.2.65536")]), /manifest limits/);
});

test("unchanged extension skips release using an ancestor baseline and deletion-aware cumulative diff", async () => {
  const { detectExtensionChanges } = await import(moduleUrl);
  const fixture = mocked();
  assert.deepEqual(await detectExtensionChanges(fixture.options), {
    needsRelease: false, baselineTag: "v0.2.1", sourceSha: head, changedFiles: ["README.md"]
  });
  assert.deepEqual(fixture.calls, [["rev-parse", "HEAD"], ["rev-parse", "--verify", "v0.2.1^{commit}"],
    ["merge-base", "--is-ancestor", baseline, head],
    ["diff", "--name-only", "--no-renames", "-z", baseline, head, "--"]]);
});

test("only genuinely absent published extension releases bootstrap; history/API failures fail closed", async () => {
  const { detectExtensionChanges } = await import(moduleUrl);
  const empty = mocked({ readReleases: async () => [] });
  assert.equal((await detectExtensionChanges(empty.options)).needsRelease, true);
  assert.deepEqual(empty.calls, [["rev-parse", "HEAD"]]);
  await assert.rejects(detectExtensionChanges(mocked({
    readReleases: async () => { throw new Error("GitHub HTTP 403"); }
  }).options), /HTTP 403/);
  await assert.rejects(detectExtensionChanges(mocked({
    readReleases: async () => Array.from({ length: 1000 }, () => release("v0.2.1"))
  }).options), /incomplete release baseline/);
});

test("invalid repository, credentials, source, missing tag, and unrelated baseline cannot skip release", async () => {
  const { detectExtensionChanges } = await import(moduleUrl);
  for (const override of [{ githubRepo: "../owner/repo" }, { token: "" }, { sourceSha: "HEAD" },
    { sourceSha: "c".repeat(40) }]) {
    await assert.rejects(detectExtensionChanges(mocked(override).options));
  }
  const missing = mocked();
  const originalGit = missing.options.gitImpl;
  missing.options.gitImpl = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("Missing baseline tag");
    return originalGit(args);
  };
  await assert.rejects(detectExtensionChanges(missing.options), /Missing baseline tag/);
  const unrelated = mocked();
  const otherGit = unrelated.options.gitImpl;
  unrelated.options.gitImpl = async (args) => {
    if (args[0] === "merge-base") throw Object.assign(new Error("unrelated"), { code: 1 });
    return otherGit(args);
  };
  await assert.rejects(detectExtensionChanges(unrelated.options), /not an ancestor/);
});

test("real Git changes accumulate since release, while documentation-only commits do not trigger a release", async (t) => {
  const { detectExtensionChanges } = await import(moduleUrl);
  const directory = await mkdtemp(path.join(os.tmpdir(), "humble-release-changes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: directory, shell: false, windowsHide: true, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
  }).trim();
  git("init", "--quiet");
  await writeFile(path.join(directory, "popup.js"), "initial shipped code\n");
  git("add", "."); git("commit", "--quiet", "-m", "initial"); git("tag", "v0.2.1");
  const decide = () => detectExtensionChanges({ githubRepo: "owner/repo", token: "test-token",
    cwd: directory, sourceSha: git("rev-parse", "HEAD"), readReleases: async () => [release("v0.2.1")] });
  await writeFile(path.join(directory, "README.md"), "documentation change\n");
  git("add", "."); git("commit", "--quiet", "-m", "docs");
  assert.equal((await decide()).needsRelease, false);
  await writeFile(path.join(directory, "popup.js"), "changed shipped code\n");
  git("add", "."); git("commit", "--quiet", "-m", "code");
  await writeFile(path.join(directory, "README.md"), "later documentation change\n");
  git("add", "."); git("commit", "--quiet", "-m", "later docs");
  assert.equal((await decide()).needsRelease, true, "code changes remain pending across later docs commits");
  git("mv", "popup.js", "README-code-example.txt");
  git("commit", "--quiet", "-m", "move source outside packaged paths");
  const renamed = await decide();
  assert.equal(renamed.needsRelease, true, "deleting/renaming shipped code requires a release");
  assert.ok(renamed.changedFiles.includes("popup.js"));
});
