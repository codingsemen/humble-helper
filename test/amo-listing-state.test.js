const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const moduleUrl = pathToFileURL(path.resolve(__dirname, "../scripts/restore-amo-listing-state.mjs"));

test("checkpoint restore uses the latest trusted completed main run, including failures", async t => {
  const { restoreAmoListingState } = await import(moduleUrl);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "amo-checkpoint-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const result = await restoreAmoListingState({ directory, repository: "owner/repo", command: async args => {
    calls.push(args);
    if (args.includes("--paginate")) return JSON.stringify([{ artifacts: [
      { id: 3, name: "firefox-listing-state", workflow_run: { id: 13, head_branch: "main" } },
      { id: 2, name: "firefox-listing-state", workflow_run: { id: 12, head_branch: "main" } },
      { id: 1, name: "firefox-listing-state", workflow_run: { id: 11, head_branch: "main" } }
    ] }]);
    if (args[0] === "api") return JSON.stringify({ id: args[1].endsWith("13") ? 13 : 12,
      head_branch: "main", head_repository: { full_name: "owner/repo" }, repository: { full_name: "owner/repo" },
      event: args[1].endsWith("13") ? "pull_request" : "workflow_dispatch",
      path: ".github/workflows/sync-firefox-listing.yml", status: "completed", conclusion: "failure" });
    return "";
  } });
  assert.deepEqual(result, { restored: true, runId: 12 });
  assert.deepEqual(calls.at(-1), ["run", "download", "12", "--repo", "owner/repo", "--name", "firefox-listing-state", "--dir", directory]);
});

test("checkpoint trust excludes other repositories, branches, workflows and pending jobs", async () => {
  const { isTrustedStateRun } = await import(moduleUrl);
  const good = { head_branch: "main", head_repository: { full_name: "owner/repo" }, repository: { full_name: "owner/repo" },
    event: "workflow_run", path: ".github/workflows/release-main.yml", status: "completed" };
  assert.equal(isTrustedStateRun(good, "owner/repo"), true);
  for (const change of [{ head_branch: "feature" }, { head_repository: { full_name: "fork/repo" } },
    { event: "pull_request_target" }, { path: ".github/workflows/ci.yml" }, { status: "in_progress" }]) {
    assert.equal(isTrustedStateRun({ ...good, ...change }, "owner/repo"), false);
  }
});
