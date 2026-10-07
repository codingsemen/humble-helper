import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { amoVersionExists } from "./check-amo-version.mjs";
import { assertReleaseVersion, fetchPublicAmoVersion } from "./release-version.mjs";
import { syncAmoListing } from "./sync-amo-listing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    } else {
      throw new Error("Usage: node scripts/run-amo-listing-sync.mjs [--version MAJOR.MINOR.PATCH] [--dry-run]");
    }
  }
  return options;
}

export async function syncCurrentAmoListing({
  version,
  dryRun = false,
  listingPath,
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
  return syncAmoListing({ listingPath, version: targetVersion, issuer, secret, fetchImpl });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => syncCurrentAmoListing(parseListingSyncArguments(process.argv.slice(2))))
    .then((result) => {
      console.log(`${result.dryRun ? "Validated" : "Synchronized"} AMO listing ${result.guid} with ${result.previewCount} previews${result.version ? ` for existing version ${result.version}` : ""}.`);
    })
    .catch((error) => {
      console.error(error && error.message ? error.message : error);
      process.exitCode = 1;
    });
}
