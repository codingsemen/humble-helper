import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const NODE_FORGE_EXCEPTION = Object.freeze({
  id: "GHSA-86w9-cpqp-85rv",
  ghsa: "GHSA-86w9-cpqp-85rv",
  package: "node-forge",
  version: "1.4.0",
  path: ".>web-ext>@devicefarmer/adbkit>node-forge",
  expiresAt: "2026-11-06T00:00:00Z",
  reason: "The vulnerable RSA verifier belongs to adbkit's Android TCPUSB bridge. " +
    "Our lint/build/sign commands do not use that bridge, and node_modules is excluded from the extension. " +
    "No patched npm release is available; review this exception when upstream publishes one."
});

const severities = ["info", "low", "moderate", "high", "critical"];
const exceptionUrl = `https://github.com/advisories/${NODE_FORGE_EXCEPTION.ghsa}`;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function hasExceptionIdentity(advisory) {
  const hasMatchingIdentity = advisory.url === exceptionUrl ||
    advisory.github_advisory_id === NODE_FORGE_EXCEPTION.ghsa;
  return hasMatchingIdentity &&
    (advisory.url === undefined || advisory.url === exceptionUrl) &&
    (advisory.github_advisory_id === undefined || advisory.github_advisory_id === NODE_FORGE_EXCEPTION.ghsa);
}

function matchesExceptionScope(advisory) {
  return hasExceptionIdentity(advisory) &&
    advisory.module_name === NODE_FORGE_EXCEPTION.package && advisory.severity === "high" &&
    advisory.findings.every((finding) =>
      finding.version === NODE_FORGE_EXCEPTION.version && finding.dev === true &&
      finding.optional === false && finding.bundled === false &&
      finding.paths.every((dependencyPath) => dependencyPath === NODE_FORGE_EXCEPTION.path)
    );
}

export function evaluateReleaseAudit(report, exitCode, now = Date.now()) {
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`Dependency audit failed to run (exit code ${exitCode}).`);
  }
  if (!isObject(report) || report.error != null) {
    throw new Error("Dependency audit returned an error instead of a completed report.");
  }
  if (!isObject(report.advisories) || !isObject(report.metadata?.vulnerabilities)) {
    throw new Error("Dependency audit report is missing advisories or vulnerability totals.");
  }

  const advisories = Object.values(report.advisories);
  const totals = Object.fromEntries(severities.map((severity) => [severity, 0]));
  for (const advisory of advisories) {
    if (!isObject(advisory) || typeof advisory.module_name !== "string" ||
        !advisory.module_name || !severities.includes(advisory.severity) ||
        !Array.isArray(advisory.findings) || advisory.findings.length === 0 ||
        !advisory.findings.every((finding) => isObject(finding) &&
          typeof finding.version === "string" && finding.version.length > 0 &&
          Array.isArray(finding.paths) && finding.paths.length > 0 &&
          finding.paths.every((dependencyPath) => typeof dependencyPath === "string" && dependencyPath.length > 0))) {
      throw new Error("Dependency audit contains an invalid advisory or dependency finding.");
    }
    totals[advisory.severity] += 1;
  }
  for (const severity of severities) {
    const declared = report.metadata.vulnerabilities[severity];
    if (!Number.isSafeInteger(declared) || declared < 0 || declared !== totals[severity]) {
      throw new Error(`Dependency audit ${severity} vulnerability total does not match its advisories.`);
    }
  }
  if (exitCode !== (advisories.length > 0 ? 1 : 0)) {
    throw new Error("Dependency audit exit code does not match its vulnerability report.");
  }
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) {
    throw new Error("Cannot evaluate dependency audit exception with an invalid date.");
  }

  const acceptedExceptions = [];
  const blockingAdvisories = [];
  for (const advisory of advisories) {
    if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
    if (matchesExceptionScope(advisory) && timestamp < Date.parse(NODE_FORGE_EXCEPTION.expiresAt)) {
      acceptedExceptions.push(advisory);
    } else {
      blockingAdvisories.push(advisory);
    }
  }
  if (blockingAdvisories.length > 0) {
    const details = blockingAdvisories.map((advisory) =>
      `${advisory.severity} ${advisory.module_name}: ${advisory.url || advisory.github_advisory_id || advisory.title || "unknown advisory"}`
    ).join("\n");
    const expiry = blockingAdvisories.some(matchesExceptionScope) &&
      timestamp >= Date.parse(NODE_FORGE_EXCEPTION.expiresAt)
      ? `\nThe temporary node-forge exception expired at ${NODE_FORGE_EXCEPTION.expiresAt}.`
      : "";
    throw Object.assign(new Error(`Release blocked by dependency vulnerabilities:\n${details}${expiry}`), {
      acceptedExceptions, blockingAdvisories
    });
  }
  return { acceptedExceptions, blockingAdvisories };
}

export function evaluateAudit(report, { auditExitCode, now = Date.now() } = {}) {
  try {
    const result = evaluateReleaseAudit(report, auditExitCode, now);
    return { ok: true, errors: [], ignored: result.acceptedExceptions, blocking: result.blockingAdvisories };
  } catch (error) {
    return { ok: false, errors: [error.message], ignored: error.acceptedExceptions || [], blocking: error.blockingAdvisories || [] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || !/^[01]$/.test(process.argv[3])) {
      throw new Error("Usage: node scripts/release-audit.mjs <pnpm-audit.json> <audit-exit-code: 0 or 1>");
    }
    const report = JSON.parse(await readFile(process.argv[2], "utf8"));
    const result = evaluateReleaseAudit(report, Number(process.argv[3]));
    for (const advisory of result.acceptedExceptions) {
      console.warn(`Temporary exception: ${advisory.url || advisory.github_advisory_id}; expires ${NODE_FORGE_EXCEPTION.expiresAt}.`);
      console.warn(NODE_FORGE_EXCEPTION.reason);
    }
    console.log("Release dependency audit passed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
