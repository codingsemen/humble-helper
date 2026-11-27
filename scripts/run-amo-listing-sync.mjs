import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { amoVersionExists } from "./check-amo-version.mjs";
import { assertReleaseVersion, fetchPublicAmoVersion } from "./release-version.mjs";
import { syncAmoListing } from "./sync-amo-listing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function listingRequestPolicy({
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = Date.now,
  log = console.log
} = {}) {
  let waited = 0;
  let nextWrite = 0;
  const wait = async milliseconds => {
    if (waited + milliseconds > 70 * 60_000) throw new Error("AMO retry wait budget exhausted; rerun after the cooldown to resume saved progress");
    waited += milliseconds;
    await sleep(milliseconds);
  };
  return {
    maximumRetryWaitMilliseconds: 3_600_000,
    onRetry: log,
    sleep: wait,
    beforeWrite: async () => {
      // Stay below AMO's 3/minute burst quota; rejected bursts also consume other quotas.
      if (now() < nextWrite) await wait(nextWrite - now());
      nextWrite = now() + 21_000;
    }
  };
}

export function parseListingSyncArguments(arguments_) {
  const options = { dryRun: false };
  // pnpm 11 forwards its explicit script-argument separator to Node.
  if (arguments_[0] === "--") arguments_ = arguments_.slice(1);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--version" && arguments_[index + 1] && options.version === undefined) {
      options.version = assertReleaseVersion(arguments_[index + 1]);
      index += 1;
    } else if (argument === "--dry-run" && !options.dryRun) {
      options.dryRun = true;
    } else if (argument === "--state-file" && arguments_[index + 1] && !options.stateFile) {
      options.stateFile = arguments_[++index];
    } else {
      throw new Error("Usage: node scripts/run-amo-listing-sync.mjs [--version MAJOR.MINOR.PATCH] [--dry-run] [--state-file path]");
    }
  }
  return options;
}

export async function syncCurrentAmoListing({
  version,
  dryRun = false,
  listingPath,
  stateFile,
  requestOptions = {},
  issuer = process.env.AMO_JWT_ISSUER,
  secret = process.env.AMO_JWT_SECRET,
  fetchImpl = globalThis.fetch
} = {}) {
  if (version !== undefined) assertReleaseVersion(version);
  // Local validation does not need AMO credentials or a network request.
  if (dryRun) return syncAmoListing({ listingPath, version, dryRun: true, fetchImpl });

  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const guid = manifest.browser_specific_settings?.gecko?.id;
  const targetVersion = version ?? await fetchPublicAmoVersion(guid, { fetchImpl });
  // Validate all repository data and assets before permitting any remote writes.
  await syncAmoListing({ listingPath, version: targetVersion, dryRun: true, fetchImpl });
  const exists = await amoVersionExists({ guid, version: targetVersion, issuer, secret, fetchImpl });
  if (!exists) {
    throw new Error(`AMO has not received listed version ${targetVersion}; listing sync cannot create an extension version`);
  }
  let state;
  if (stateFile) {
    try { state = JSON.parse(await readFile(stateFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return syncAmoListing({
    listingPath, version: targetVersion, issuer, secret, fetchImpl, state,
    saveState: async checkpoint => {
      if (!stateFile) return;
      await mkdir(path.dirname(stateFile), { recursive: true });
      await writeFile(`${stateFile}.tmp`, `${JSON.stringify(checkpoint)}\n`, "utf8");
      await rename(`${stateFile}.tmp`, stateFile);
    },
    requestOptions
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => syncCurrentAmoListing({ ...parseListingSyncArguments(process.argv.slice(2)), requestOptions: listingRequestPolicy() }))
    .then((result) => {
      console.log(`${result.dryRun ? "Validated" : "Synchronized"} AMO listing ${result.guid} with ${result.previewCount} previews${result.version ? ` for existing version ${result.version}` : ""}.`);
    })
    .catch((error) => {
      console.error(error && error.message ? error.message : error);
      process.exitCode = 1;
    });
}
