import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveReleaseVersion } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestTimeoutMilliseconds = 60_000;
const pollIntervalMilliseconds = 5_000;
const maximumPollAttempts = 24;
const maximumPackageBytes = 50 * 1024 * 1024;

function requiredEnvironmentValue(name, pattern) {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(requestTimeoutMilliseconds)
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`Chrome Web Store returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const detail = JSON.stringify(parsed).slice(0, 1_000);
    throw new Error(`Chrome Web Store request failed with HTTP ${response.status}: ${detail}`);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function publishChrome(packageArgument) {
  if (!packageArgument) {
    throw new Error("Usage: node scripts/publish-chrome.mjs <chrome-package.zip>");
  }

  const packagePath = path.resolve(root, packageArgument);
  const releaseDirectory = path.join(root, "release-artifacts");
  const relativePackagePath = path.relative(releaseDirectory, packagePath);
  if (relativePackagePath.startsWith("..") || path.isAbsolute(relativePackagePath)) {
    throw new Error("Chrome package must come from the verified release-artifacts directory");
  }
  const releaseDirectoryStats = await lstat(releaseDirectory);
  if (releaseDirectoryStats.isSymbolicLink() || !releaseDirectoryStats.isDirectory()) {
    throw new Error("release-artifacts must be a regular directory");
  }
  const stats = await lstat(packagePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0 || stats.size > maximumPackageBytes) {
    throw new Error("Chrome package must be a non-empty regular ZIP smaller than 50 MiB");
  }
  if (path.extname(packagePath).toLowerCase() !== ".zip") {
    throw new Error("Chrome package must be a ZIP file");
  }

  const accessToken = requiredEnvironmentValue("CHROME_ACCESS_TOKEN");
  const publisherId = requiredEnvironmentValue("CHROME_PUBLISHER_ID", /^[A-Za-z0-9_-]{1,128}$/);
  const extensionId = requiredEnvironmentValue("CHROME_EXTENSION_ID", /^[a-p]{32}$/);
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const version = effectiveReleaseVersion(packageMetadata.version, manifest.version);
  const itemName = `publishers/${publisherId}/items/${extensionId}`;
  const authorization = `Bearer ${accessToken}`;

  const upload = await requestJson(
    `https://chromewebstore.googleapis.com/upload/v2/${itemName}:upload`,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/zip"
      },
      body: await readFile(packagePath)
    }
  );

  let uploadState = upload.uploadState;
  for (
    let attempt = 0;
    ["IN_PROGRESS", "NOT_FOUND"].includes(uploadState) && attempt < maximumPollAttempts;
    attempt += 1
  ) {
    await delay(pollIntervalMilliseconds);
    const status = await requestJson(
      `https://chromewebstore.googleapis.com/v2/${itemName}:fetchStatus`,
      { headers: { Authorization: authorization } }
    );
    uploadState = status.lastAsyncUploadState;
  }
  if (uploadState !== "SUCCEEDED") {
    throw new Error(`Chrome Web Store upload did not succeed (state: ${uploadState || "missing"})`);
  }
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(
      `Chrome Web Store reported version ${upload.crxVersion}, expected ${version}`
    );
  }

  const submission = await requestJson(
    `https://chromewebstore.googleapis.com/v2/${itemName}:publish`,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ blockOnWarnings: true })
    }
  );
  if (!submission.state) {
    throw new Error("Chrome Web Store publish response did not include a submission state");
  }
  process.stdout.write(
    `Chrome Web Store accepted version ${version}; submission state: ${submission.state}.\n`
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--") {
    arguments_.shift();
  }
  publishChrome(arguments_[0]).catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
