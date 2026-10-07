import { createHmac, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultListingPath = path.join(root, "store", "firefox", "listing.json");
const defaultApiBaseUrl = "https://addons.mozilla.org/api/v5";
const requestTimeoutMilliseconds = 60_000;
const maximumAssetBytes = 4 * 1024 * 1024;
const maximumPreviewCount = 5;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const translatedMetadataFields = [
  "name", "summary", "description", "homepage", "support_email", "support_url", "developer_comments"
];
const outgoingUrlFields = new Set(["homepage", "support_url"]);
const metadataFields = new Set([
  "categories",
  "contributions_url",
  "default_locale",
  "description",
  "developer_comments",
  "homepage",
  "is_disabled",
  "is_experimental",
  "name",
  "requires_payment",
  "slug",
  "summary",
  "support_email",
  "support_url",
  "tags"
]);

class AmoApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AmoApiError";
    this.status = status;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createJwt(issuer, secret, nowSeconds = Math.floor(Date.now() / 1_000)) {
  if (typeof issuer !== "string" || issuer.length === 0) {
    throw new Error("AMO_JWT_ISSUER is missing");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("AMO_JWT_SECRET is missing");
  }

  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: issuer,
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + 300
  }));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${signingInput}.${signature}`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function validateLocaleMap(value, label) {
  assertPlainObject(value, label);
  const locales = Object.keys(value);
  if (locales.length === 0 || locales.some((locale) => !localePattern.test(locale))) {
    throw new Error(`${label} must contain at least one valid locale`);
  }
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text !== "string" || text.length === 0 || text.length > 200_000) {
      throw new Error(`${label}.${locale} must be a non-empty string of at most 200000 characters`);
    }
  }
}

function validateMetadata(metadata) {
  assertPlainObject(metadata, "metadata");
  for (const key of Object.keys(metadata)) {
    if (!metadataFields.has(key)) {
      throw new Error(`metadata.${key} is not an allowed AMO listing field`);
    }
  }

  for (const field of translatedMetadataFields) {
    if (field in metadata) {
      validateLocaleMap(metadata[field], `metadata.${field}`);
    }
  }

  if ("default_locale" in metadata
    && (typeof metadata.default_locale !== "string" || !localePattern.test(metadata.default_locale))) {
    throw new Error("metadata.default_locale must be a valid locale");
  }

  if ("categories" in metadata) {
    assertPlainObject(metadata.categories, "metadata.categories");
    for (const [application, categories] of Object.entries(metadata.categories)) {
      if (!["firefox", "android"].includes(application)
        || !Array.isArray(categories)
        || categories.length === 0
        || categories.some((category) => typeof category !== "string" || category.length === 0)) {
        throw new Error("metadata.categories must map Firefox or Android to non-empty string arrays");
      }
    }
  }

  if ("tags" in metadata) {
    if (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== "string" || tag.length === 0)) {
      throw new Error("metadata.tags must be an array of non-empty strings");
    }
  }

  for (const field of ["requires_payment", "is_experimental", "is_disabled"]) {
    if (field in metadata && typeof metadata[field] !== "boolean") {
      throw new Error(`metadata.${field} must be boolean`);
    }
  }
}

export function validateListing(listing) {
  assertPlainObject(listing, "listing");
  const allowedFields = new Set([
    "guid",
    "default_locale",
    "license",
    "metadata",
    "icon",
    "replace_existing_previews",
    "previews",
    "release_notes"
  ]);
  for (const key of Object.keys(listing)) {
    if (!allowedFields.has(key)) {
      throw new Error(`listing.${key} is not an allowed field`);
    }
  }

  if (typeof listing.guid !== "string" || listing.guid.length === 0 || listing.guid.length > 255) {
    throw new Error("listing.guid must be a non-empty extension ID");
  }
  if (typeof listing.default_locale !== "string" || !localePattern.test(listing.default_locale)) {
    throw new Error("listing.default_locale must be a valid locale");
  }
  if (typeof listing.license !== "string" || listing.license.length === 0 || listing.license.length > 128) {
    throw new Error("listing.license must be a non-empty SPDX license identifier");
  }
  validateMetadata(listing.metadata);
  if (listing.metadata.default_locale && listing.metadata.default_locale !== listing.default_locale) {
    throw new Error("listing.default_locale and metadata.default_locale must match");
  }
  for (const field of translatedMetadataFields) {
    if (field in listing.metadata && !listing.metadata[field][listing.default_locale]) {
      throw new Error(`metadata.${field} must contain the default locale ${listing.default_locale}`);
    }
  }

  if (typeof listing.icon !== "string" || listing.icon.length === 0) {
    throw new Error("listing.icon must be a repository-relative image path");
  }
  if (listing.replace_existing_previews !== true) {
    throw new Error("listing.replace_existing_previews must be true to keep AMO previews in repository sync");
  }
  if (!Array.isArray(listing.previews) || listing.previews.length === 0 || listing.previews.length > maximumPreviewCount) {
    throw new Error(`listing.previews must contain between 1 and ${maximumPreviewCount} entries`);
  }
  for (const [index, preview] of listing.previews.entries()) {
    assertPlainObject(preview, `listing.previews[${index}]`);
    if (typeof preview.path !== "string" || preview.path.length === 0) {
      throw new Error(`listing.previews[${index}].path must be a repository-relative image path`);
    }
    validateLocaleMap(preview.caption, `listing.previews[${index}].caption`);
  }
  if ("release_notes" in listing) {
    validateLocaleMap(listing.release_notes, "listing.release_notes");
  }
  return listing;
}

export function buildMetadataPayload(listing, addon) {
  validateListing(listing);
  const metadata = structuredClone({
    default_locale: listing.default_locale,
    ...listing.metadata
  });
  if (!addon || addon.default_locale === listing.default_locale) return metadata;
  if (typeof addon.default_locale !== "string" || !localePattern.test(addon.default_locale)) {
    throw new Error("AMO listing must include its current default locale before changing it");
  }

  // AMO validates every populated translated field when default_locale changes,
  // even fields omitted from a PATCH. Retain the old default's fallback rather
  // than clearing dashboard-managed contact information or inventing values.
  for (const field of translatedMetadataFields) {
    if (field in metadata || addon[field] == null) continue;
    const value = addon[field];
    const translations = outgoingUrlFields.has(field) ? value.url : value;
    assertPlainObject(translations, `AMO ${field} translations`);
    const entries = Object.entries(translations);
    if (entries.some(([locale, text]) => !localePattern.test(locale)
      || (text !== null && typeof text !== "string"))) {
      throw new Error(`AMO ${field} must contain full locale maps, not localized or outgoing values`);
    }
    if (!entries.some(([, text]) => typeof text === "string" && text.length > 0)
      || translations[listing.default_locale]) continue;
    const fallback = translations[addon.default_locale];
    if (typeof fallback !== "string" || fallback.length === 0) {
      throw new Error(`AMO ${field} has no ${addon.default_locale} fallback; add metadata.${field}.${listing.default_locale} explicitly`);
    }
    metadata[field] = {
      ...Object.fromEntries(entries.filter(([, text]) => typeof text === "string" && text.length > 0)),
      [listing.default_locale]: fallback
    };
    validateLocaleMap(metadata[field], `metadata.${field}`);
  }
  return metadata;
}

export function buildSubmissionMetadata(listing) {
  validateListing(listing);
  const categories = listing.metadata.categories?.firefox;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("listing.metadata.categories.firefox is required for the AMO submission");
  }
  if (!listing.metadata.summary) {
    throw new Error("listing.metadata.summary is required for the AMO submission");
  }
  return {
    summary: listing.metadata.summary,
    categories,
    version: { license: listing.license }
  };
}

function repositoryPath(relativePath, label) {
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return absolutePath;
}

async function readAsset(relativePath, label) {
  const absolutePath = repositoryPath(relativePath, label);
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0 || stats.size > maximumAssetBytes) {
    throw new Error(`${label} must be a non-empty regular image smaller than 4 MiB`);
  }
  const extension = path.extname(absolutePath).toLowerCase();
  const bytes = await readFile(absolutePath);
  const isPng = extension === ".png"
    && bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = [".jpg", ".jpeg"].includes(extension)
    && bytes.length >= 2
    && bytes[0] === 0xff
    && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) {
    throw new Error(`${label} must be a PNG or JPEG image`);
  }
  return {
    absolutePath,
    bytes,
    contentType: isPng ? "image/png" : "image/jpeg"
  };
}

function apiPathForAddon(guid) {
  return `/addons/addon/${encodeURIComponent(guid)}/`;
}

function apiPathForPreview(guid, previewId) {
  return `${apiPathForAddon(guid)}previews/${encodeURIComponent(String(previewId))}/`;
}

function apiPathForVersion(guid, version) {
  return `${apiPathForAddon(guid)}versions/v${version}/`;
}

function responseErrorMessage(body, status) {
  let detail = "";
  try {
    const parsed = body ? JSON.parse(body) : {};
    detail = JSON.stringify(parsed).slice(0, 1_000);
  } catch {
    detail = body.slice(0, 1_000);
  }
  return `AMO API returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

async function amoRequest({
  apiBaseUrl,
  issuer,
  secret,
  fetchImpl,
  pathname,
  method = "GET",
  body,
  form
}) {
  const headers = {
    Accept: "application/json",
    Authorization: `JWT ${createJwt(issuer, secret)}`
  };
  let requestBody = form;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetchImpl(`${apiBaseUrl}${pathname}`, {
    method,
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(requestTimeoutMilliseconds)
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new AmoApiError(responseErrorMessage(responseText, response.status), response.status);
  }
  if (!responseText) {
    return {};
  }
  try {
    return JSON.parse(responseText);
  } catch {
    throw new AmoApiError(`AMO API returned non-JSON HTTP ${response.status}`, response.status);
  }
}

async function loadListing(filePath) {
  const listing = JSON.parse(await readFile(filePath, "utf8"));
  validateListing(listing);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const manifestGuid = manifest?.browser_specific_settings?.gecko?.id;
  if (manifestGuid !== listing.guid) {
    throw new Error(`AMO listing GUID ${listing.guid} does not match manifest GUID ${manifestGuid || "missing"}`);
  }
  return listing;
}

export async function writeSubmissionMetadata({
  listingPath = defaultListingPath,
  outputPath
} = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("An output path is required for generated AMO submission metadata");
  }
  const listing = await loadListing(listingPath);
  const output = repositoryPath(outputPath, "submission metadata output");
  await writeFile(output, `${JSON.stringify(buildSubmissionMetadata(listing), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return output;
}

async function getAddon({ apiBaseUrl, issuer, secret, fetchImpl, listing }) {
  // Do not request a single language: migration requires complete locale maps.
  const pathname = apiPathForAddon(listing.guid);
  const maximumAttempts = 12;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await amoRequest({ apiBaseUrl, issuer, secret, fetchImpl, pathname });
    } catch (error) {
      if (!(error instanceof AmoApiError) || error.status !== 404 || attempt === maximumAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error("AMO listing could not be loaded");
}

function previewIds(addon) {
  if (!Array.isArray(addon.previews)) {
    return [];
  }
  return addon.previews
    .map((preview) => Number(preview && preview.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function createdPreviewId(response) {
  const candidates = [response?.id, response?.preview?.id, response?.data?.id].map(Number);
  return candidates.find((id) => Number.isInteger(id) && id > 0);
}

async function uploadPreview({ apiBaseUrl, issuer, secret, fetchImpl, listing, preview, position }) {
  const asset = await readAsset(preview.path, `listing.previews[${position}].path`);
  const form = new FormData();
  form.set("image", new Blob([asset.bytes], { type: asset.contentType }), path.basename(asset.absolutePath));
  form.set("position", String(position));
  const response = await amoRequest({
    apiBaseUrl,
    issuer,
    secret,
    fetchImpl,
    pathname: `${apiPathForAddon(listing.guid)}previews/`,
    method: "POST",
    form
  });
  const id = createdPreviewId(response);
  if (!Number.isInteger(id)) {
    throw new Error(`AMO did not return an ID for preview ${position + 1}`);
  }
  await amoRequest({
    apiBaseUrl,
    issuer,
    secret,
    fetchImpl,
    pathname: apiPathForPreview(listing.guid, id),
    method: "PATCH",
    body: { caption: preview.caption, position }
  });
  return id;
}

export async function syncAmoListing({
  listingPath = defaultListingPath,
  version,
  issuer = process.env.AMO_JWT_ISSUER,
  secret = process.env.AMO_JWT_SECRET,
  apiBaseUrl = defaultApiBaseUrl,
  fetchImpl = globalThis.fetch,
  dryRun = false
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }
  if (!dryRun && version === undefined) {
    throw new Error("A release version is required for a live AMO listing synchronization");
  }
  const listing = await loadListing(listingPath);
  let metadata = buildMetadataPayload(listing);
  if (version !== undefined && !versionPattern.test(version)) {
    throw new Error("AMO release version must use MAJOR.MINOR.PATCH");
  }
  if ("release_notes" in listing && version === undefined) {
    throw new Error("A release version is required when listing.release_notes is present");
  }

  const assets = await Promise.all([
    readAsset(listing.icon, "listing.icon"),
    ...listing.previews.map((preview, index) => readAsset(preview.path, `listing.previews[${index}].path`))
  ]);
  if (dryRun) {
    return {
      guid: listing.guid,
      metadata,
      iconBytes: assets[0].bytes.length,
      previewCount: listing.previews.length,
      version: version || null,
      dryRun: true
    };
  }

  const addon = await getAddon({ apiBaseUrl, issuer, secret, fetchImpl, listing });
  metadata = buildMetadataPayload(listing, addon);
  await amoRequest({
    apiBaseUrl,
    issuer,
    secret,
    fetchImpl,
    pathname: apiPathForAddon(listing.guid),
    method: "PATCH",
    body: metadata
  });

  const icon = assets[0];
  const iconForm = new FormData();
  iconForm.set("icon", new Blob([icon.bytes], { type: icon.contentType }), path.basename(icon.absolutePath));
  await amoRequest({
    apiBaseUrl,
    issuer,
    secret,
    fetchImpl,
    pathname: apiPathForAddon(listing.guid),
    method: "PATCH",
    form: iconForm
  });

  if (listing.replace_existing_previews) {
    for (const id of previewIds(addon)) {
      await amoRequest({
        apiBaseUrl,
        issuer,
        secret,
        fetchImpl,
        pathname: apiPathForPreview(listing.guid, id),
        method: "DELETE"
      });
    }
  }

  for (const [position, preview] of listing.previews.entries()) {
    await uploadPreview({ apiBaseUrl, issuer, secret, fetchImpl, listing, preview, position });
  }

  if ("release_notes" in listing) {
    await amoRequest({
      apiBaseUrl,
      issuer,
      secret,
      fetchImpl,
      pathname: apiPathForVersion(listing.guid, version),
      method: "PATCH",
      body: { release_notes: listing.release_notes }
    });
  }

  return {
    guid: listing.guid,
    metadata,
    previewCount: listing.previews.length,
    version: version || null,
    dryRun: false
  };
}

function parseArguments(arguments_) {
  const options = { listingPath: defaultListingPath, dryRun: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--listing" && arguments_[index + 1]) {
      options.listingPath = repositoryPath(arguments_[index + 1], "--listing");
      index += 1;
      continue;
    }
    if (argument === "--version" && arguments_[index + 1]) {
      options.version = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--write-submission-metadata" && arguments_[index + 1]) {
      options.submissionMetadataPath = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error("Usage: node scripts/sync-amo-listing.mjs [--listing path] [--version MAJOR.MINOR.PATCH] [--dry-run] [--write-submission-metadata path]");
  }
  return options;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  const operation = options.submissionMetadataPath
    ? writeSubmissionMetadata({ listingPath: options.listingPath, outputPath: options.submissionMetadataPath })
        .then((output) => ({ output }))
    : syncAmoListing(options);
  operation
    .then((result) => {
      if (result.output) {
        process.stdout.write(`Generated AMO submission metadata at ${path.relative(root, result.output)}.\n`);
      } else {
        process.stdout.write(
          `${result.dryRun ? "Validated" : "Synchronized"} AMO listing ${result.guid} with ${result.previewCount} previews.\n`
        );
      }
    })
    .catch((error) => {
      console.error(error && error.message ? error.message : error);
      process.exitCode = 1;
    });
}
