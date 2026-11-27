import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJwt } from "./sync-amo-listing.mjs";
import { releaseVersionFromTag } from "./release-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function amoVersionExists({
  guid,
  version,
  issuer = process.env.AMO_JWT_ISSUER,
  secret = process.env.AMO_JWT_SECRET,
  allowExisting = true,
  fetchImpl = fetch
}) {
  releaseVersionFromTag(`v${version}`);
  if (typeof guid !== "string" || !guid) throw new Error("Firefox add-on ID is missing");
  if (typeof allowExisting !== "boolean") throw new Error("allowExisting must be a boolean");
  const response = await fetchImpl(
    `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(guid)}/versions/v${version}/`,
    {
      headers: { Authorization: `JWT ${createJwt(issuer, secret)}`, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000)
    }
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`AMO version check returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.version !== version || !payload.file || typeof payload.file.status !== "string") {
    throw new Error("AMO returned an unexpected version payload");
  }
  if (payload.channel !== "listed" || payload.is_disabled === true) {
    throw new Error(`AMO version ${version} is unlisted or developer-disabled; resolve it in the developer dashboard`);
  }
  if (!["public", "unreviewed"].includes(payload.file.status)) {
    throw new Error(`AMO version ${version} has status ${payload.file.status}; resolve it in the developer dashboard`);
  }
  if (!allowExisting) {
    throw new Error(
      `AMO version ${version} is already occupied; a newly allocated release cannot reuse an existing upload. Resolve the version collision in the developer dashboard before retrying`
    );
  }
  return true;
}

export function parseAmoVersionArguments(arguments_) {
  const [tag, ...options] = arguments_;
  const version = releaseVersionFromTag(tag);
  if (options.length === 0) return { version, allowExisting: true };
  if (options.length === 1 && options[0] === "--require-new") {
    return { version, allowExisting: false };
  }
  if (options.length === 2 && options[0] === "--allow-existing" && ["true", "false"].includes(options[1])) {
    return { version, allowExisting: options[1] === "true" };
  }
  if (options.length === 1 && /^--allow-existing=(true|false)$/.test(options[0])) {
    return { version, allowExisting: options[0] === "--allow-existing=true" };
  }
  throw new Error("Usage: node scripts/check-amo-version.mjs <vMAJOR.MINOR.PATCH> [--allow-existing true|false | --require-new]");
}

async function main() {
  const { version, allowExisting } = parseAmoVersionArguments(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const exists = await amoVersionExists({ guid: manifest.browser_specific_settings?.gecko?.id, version, allowExisting });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `exists=${exists}\n`);
  }
  console.log(exists
    ? `AMO already received ${version}; skipping duplicate submission.`
    : `AMO has not received ${version}; ready to submit.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
