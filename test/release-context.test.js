const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "release-context.mjs"));
const head = "a".repeat(40);
const released = "b".repeat(40);
const synced = "c".repeat(40);
const listing = { icon: "store/chrome/icon-128.png", previews: [{ path: "store/chrome/screenshots/01.png" }] };
const release = (tag, options = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...options });
const job = (completedAt, options = {}) => ({
  name: "Synchronize Firefox listing / Synchronize metadata without uploading an extension",
  conclusion: "success", completed_at: completedAt, ...options
});
const run = (id, sha, updatedAt, options = {}) => ({
  id, head_sha: sha, head_branch: "main", head_repository: { full_name: "owner/repo" },
  status: "completed", event: "workflow_run", updated_at: updatedAt, conclusion: "success", ...options
});

function mockContext({ releases = [release("v0.2.1")], runs = [], standaloneRuns = [], jobs = {},
  changed = [], failures = {}, nonAncestors = [], customGit } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace("/repos/owner/repo", "");
    calls.push({ route, options, search: parsed.search });
    if (failures[route]) return { ok: false, status: failures[route] };
    let value;
    if (route === "/releases") value = releases;
    else if (route === "/actions/workflows/release-main.yml/runs") value = { workflow_runs: runs };
    else if (route === "/actions/workflows/sync-firefox-listing.yml/runs") value = { workflow_runs: standaloneRuns };
    else if (/^\/actions\/runs\/\d+\/jobs$/.test(route)) value = { jobs: jobs[route.split("/")[3]] || [] };
    else assert.fail(`Unexpected GitHub route: ${route}`);
    return { ok: true, status: 200, async json() { return value; } };
  };
  const gitCalls = [];
  const gitImpl = async (arguments_) => {
    gitCalls.push(arguments_);
    if (customGit) return customGit(arguments_);
    if (arguments_[0] === "rev-parse") return arguments_[1] === "HEAD" ? `${head}\n` : `${released}\n`;
    if (arguments_[0] === "merge-base") {
      if (nonAncestors.includes(arguments_[2])) throw Object.assign(new Error("not ancestor"), { code: 1 });
      return "";
    }
    if (arguments_[0] === "diff") return changed.join("\0") + (changed.length ? "\0" : "");
    assert.fail(`Unexpected git call: ${arguments_.join(" ")}`);
  };
  return { calls, gitCalls, options: { githubRepo: "owner/repo", token: "test-token", currentRunId: "999", listing, fetchImpl, gitImpl } };
}

test("release baseline selects highest canonical published stable version, not GitHub latest/date order", async () => {
  const { selectPublishedReleaseTag } = await import(moduleUrl);
  assert.equal(selectPublishedReleaseTag([
    release("v0.2.9"), release("v0.2.10"), release("v0.3.0", { draft: true }),
    release("v1.0.0", { prerelease: true }), release("v00.4.0"), release("docs-2026")
  ]), "v0.2.10");
  assert.equal(selectPublishedReleaseTag([]), "");
  assert.equal(selectPublishedReleaseTag([release("v0.2.2", { draft: true })]), "");
  assert.throws(() => selectPublishedReleaseTag([{}]), /invalid release/);
  assert.throws(() => selectPublishedReleaseTag([release("v0.2.65536")]), /manifest limits/);
});

test("listing changes include configured store assets and sync dependencies, not unrelated code or pipeline/docs", async () => {
  const { hasListingChanges, listingRelevantPaths } = await import(moduleUrl);
  for (const changed of ["store/firefox/listing.json", "scripts/run-amo-listing-sync.mjs",
    "scripts/check-amo-version.mjs", "scripts/release-artifacts.mjs", "icons/icon-128.png",
    listing.icon, listing.previews[0].path, ".github/workflows/sync-firefox-listing.yml"]) {
    assert.equal(hasListingChanges([changed], listing), true, changed);
  }
  assert.equal(hasListingChanges(["background.js", "publish.md", "store/firefox/README.md", ".github/workflows/ci.yml"], listing), false);
  assert.throws(() => listingRelevantPaths({ ...listing, icon: "../outside.png" }), /safe repository-relative/);
  assert.throws(() => listingRelevantPaths({ ...listing, previews: [{ path: "C:\\outside.png" }] }), /safe repository-relative/);
});

test("absent successful listing history forces first synchronization without guessing a release baseline", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const mocked = mockContext();
  const result = await readReleaseContext(mocked.options);
  assert.deepEqual(result, { baselineTag: "v0.2.1", baselineSha: released, listingChanged: true, listingBaselineSha: "" });
  assert.ok(mocked.calls.every(({ options }) => options.headers.Authorization === "Bearer test-token"));
  assert.ok(mocked.gitCalls.some((arguments_) => arguments_.join(" ") === `merge-base --is-ancestor ${released} ${head}`));
  const initial = mockContext({ releases: [] });
  assert.equal((await readReleaseContext(initial.options)).baselineTag, "");
});

test("successful listing job counts even when a sibling job failed, with changes accumulated since its SHA", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const mocked = mockContext({
    runs: [run(1, synced, "2026-10-07T09:10:00Z", { conclusion: "failure" }), run(2, head, "2026-10-07T09:20:00Z")],
    jobs: { 1: [job("2026-10-07T09:05:00Z")], 2: [job("2026-10-07T09:15:00Z", { conclusion: "failure" })] },
    changed: [listing.previews[0].path]
  });
  const result = await readReleaseContext(mocked.options);
  assert.equal(result.listingBaselineSha, synced);
  assert.equal(result.listingChanged, true);
  assert.deepEqual(mocked.gitCalls.at(-1), ["diff", "--name-only", "-z", synced, head, "--"]);
  assert.ok(mocked.calls.filter(({ route }) => route.endsWith("/jobs"))
    .every(({ search }) => new URLSearchParams(search).get("filter") === "all"), "retain successful syncs from earlier attempts");
});

test("standalone and automatic listing jobs are compared by completion time and no relevant diff skips sync", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const mocked = mockContext({
    runs: [run(1, released, "2026-10-07T09:30:00Z")],
    standaloneRuns: [run(2, synced, "2026-10-07T09:20:00Z", { event: "workflow_dispatch" })],
    jobs: { 1: [job("2026-10-07T09:00:00Z")], 2: [job("2026-10-07T09:15:00Z", { name: "Synchronize metadata without uploading an extension" })] },
    changed: [".github/workflows/release-main.yml", "publish.md"]
  });
  const result = await readReleaseContext(mocked.options);
  assert.equal(result.listingBaselineSha, synced);
  assert.equal(result.listingChanged, false);
});

test("later failed actual sync forces repair with unchanged listing inputs and keeps earlier successful baseline", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required"]) {
    const mocked = mockContext({
      runs: [run(1, synced, "2026-10-07T09:10:00Z"), run(2, head, "2026-10-07T09:20:00Z", { conclusion })],
      jobs: { 1: [job("2026-10-07T09:05:00Z")], 2: [job("2026-10-07T09:15:00Z", { conclusion })] },
      changed: ["publish.md"]
    });
    const result = await readReleaseContext(mocked.options);
    assert.equal(result.listingBaselineSha, synced, conclusion);
    assert.equal(result.listingChanged, true, conclusion);
  }
});

test("a later successful attempt clears older partial-sync failures, including earlier rerun attempts", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const mocked = mockContext({
    runs: [run(1, synced, "2026-10-07T09:10:00Z"), run(2, head, "2026-10-07T09:30:00Z")],
    jobs: {
      1: [job("2026-10-07T09:05:00Z")],
      2: [job("2026-10-07T09:15:00Z", { conclusion: "failure" }), job("2026-10-07T09:25:00Z")]
    }
  });
  const result = await readReleaseContext(mocked.options);
  assert.equal(result.listingBaselineSha, head);
  assert.equal(result.listingChanged, false);
});

test("failed siblings and skipped sync jobs do not dirty a previously successful unchanged listing", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const mocked = mockContext({
    runs: [run(1, synced, "2026-10-07T09:10:00Z"), run(2, head, "2026-10-07T09:20:00Z", { conclusion: "failure" })],
    jobs: {
      1: [job("2026-10-07T09:05:00Z")],
      2: [job("2026-10-07T09:15:00Z", { name: "Submit Firefox package", conclusion: "failure" }),
        job(null, { conclusion: "skipped" })]
    },
    changed: [".github/workflows/ci.yml"]
  });
  const result = await readReleaseContext(mocked.options);
  assert.equal(result.listingBaselineSha, synced);
  assert.equal(result.listingChanged, false);
});

test("non-main, current-run, unrelated history and unsuccessful listing jobs cannot suppress repair", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const mocked = mockContext({
    runs: [run(999, head, "2026-10-07T09:30:00Z"), run(1, synced, "2026-10-07T09:20:00Z", { head_branch: "topic" }),
      run(2, synced, "2026-10-07T09:15:00Z")],
    jobs: { 2: [job("2026-10-07T09:10:00Z")] }, nonAncestors: [synced]
  });
  const result = await readReleaseContext(mocked.options);
  assert.equal(result.listingChanged, true);
  assert.equal(result.listingBaselineSha, "");
  assert.equal(mocked.calls.filter(({ route }) => route.endsWith("/jobs")).length, 0);
});

test("only successful actual sync jobs count, including reusable job display prefixes", async () => {
  const { successfulListingJobs } = await import(moduleUrl);
  assert.equal(successfulListingJobs([
    job("2026-10-07T09:00:00Z"), job("2026-10-07T09:05:00Z", { name: "CI" }),
    job("2026-10-07T09:10:00Z", { conclusion: "skipped" })
  ]).length, 1);
  assert.throws(() => successfulListingJobs([job(null)]), /invalid listing completion time/);
});

test("missing newly added workflow is harmless, while API/auth failures and unrelated release tags fail closed", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const absent = mockContext({ failures: { "/actions/workflows/sync-firefox-listing.yml/runs": 404 } });
  assert.equal((await readReleaseContext(absent.options)).listingChanged, true);
  for (const route of ["/releases", "/actions/workflows/release-main.yml/runs"]) {
    for (const status of [401, 403, 429, 500]) {
      const mocked = mockContext({ failures: { [route]: status } });
      await assert.rejects(() => readReleaseContext(mocked.options), new RegExp(`HTTP ${status}`));
    }
  }
  const unrelated = mockContext({ nonAncestors: [released] });
  await assert.rejects(() => readReleaseContext(unrelated.options), /not an ancestor/);
});

test("incomplete listing scan conservatively forces sync; incomplete releases never bootstrap", async () => {
  const { readReleaseContext } = await import(moduleUrl);
  const manyRuns = Array.from({ length: 100 }, (_, index) => run(index + 1, synced, "2026-10-07T09:20:00Z"));
  const history = mockContext({ runs: manyRuns });
  const result = await readReleaseContext({ ...history.options, pageLimit: 1 });
  assert.equal(result.listingChanged, true);
  assert.equal(result.listingBaselineSha, "");
  const releases = mockContext({ releases: Array.from({ length: 100 }, () => release("v0.2.1")) });
  await assert.rejects(() => readReleaseContext({ ...releases.options, pageLimit: 1 }), /incomplete release baseline/);
});
