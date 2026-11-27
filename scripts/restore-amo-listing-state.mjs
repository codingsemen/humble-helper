import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const artifactName = "firefox-listing-state";
const trustedWorkflows = new Set([
  ".github/workflows/release-main.yml", ".github/workflows/release.yml", ".github/workflows/sync-firefox-listing.yml"
]);

export function isTrustedStateRun(run, repository) {
  return run.head_branch === "main" && run.head_repository?.full_name === repository
    && run.repository?.full_name === repository
    && ["workflow_run", "workflow_dispatch"].includes(run.event)
    && trustedWorkflows.has(run.path) && run.status === "completed";
}

export async function restoreAmoListingState({ repository = process.env.GH_REPO, directory, command } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || !directory) {
    throw new Error("GH_REPO and a checkpoint directory are required");
  }
  command ||= async args => (await runFile("gh", args, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024
  })).stdout;
  const pages = JSON.parse(await command(["api", "--paginate", "--slurp",
    `repos/${repository}/actions/artifacts?name=${artifactName}&per_page=100`]));
  const artifacts = pages.flatMap(page => page.artifacts)
    .filter(a => a.name === artifactName && !a.expired && a.workflow_run?.head_branch === "main")
    .sort((a, b) => b.id - a.id);
  for (const artifact of artifacts) {
    const run = JSON.parse(await command(["api", `repos/${repository}/actions/runs/${artifact.workflow_run.id}`]));
    if (!isTrustedStateRun(run, repository)) continue;
    await mkdir(directory, { recursive: true });
    await command(["run", "download", String(run.id), "--repo", repository, "--name", artifactName, "--dir", directory]);
    return { restored: true, runId: run.id };
  }
  return { restored: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreAmoListingState({ directory: process.argv[2] })
    .then(result => console.log(result.restored ? `Restored listing checkpoint from run ${result.runId}.` : "No listing checkpoint yet; starting asset reconciliation."))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
