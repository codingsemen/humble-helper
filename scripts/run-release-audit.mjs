import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateAudit, NODE_FORGE_EXCEPTION } from "./release-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function plainText(value) {
  return String(value).replace(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    (character) => character === "\n" ? "\\n" : character === "\r" ? "\\r" :
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function annotationText(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function summaryText(value) {
  return plainText(value).replace(/[&<>|`\[\]\\]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "`": "&#96;",
    "[": "&#91;", "]": "&#93;", "\\": "&#92;"
  })[character]);
}

function advisoryIdentity(advisory) {
  const ghsa = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
  if (ghsa.test(advisory.github_advisory_id || "")) return advisory.github_advisory_id;
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(advisory.url || "");
  return match?.[1] || advisory.title || "Unidentified advisory";
}

function advisoryDetails(advisory) {
  const versions = [...new Set(advisory.findings.map((finding) => finding.version))].join(", ");
  const paths = [...new Set(advisory.findings.flatMap((finding) => finding.paths))].join(", ");
  return `${advisoryIdentity(advisory)}; ${advisory.module_name} ${versions}; ${advisory.severity}; dependency path ${paths}`;
}

export function auditAnnotations(decision) {
  return [
    ...decision.ignored.map((advisory) => `::warning::${annotationText(
      `Accepted temporary exception: ${advisoryDetails(advisory)}; accepted until ${NODE_FORGE_EXCEPTION.expiresAt}.`
    )}`),
    ...decision.blocking.map((advisory) => `::error::${annotationText(`Blocked dependency advisory: ${advisoryDetails(advisory)}.`)}`),
    ...decision.errors.map((error) => `::error::${annotationText(`Dependency audit error: ${error}`)}`)
  ];
}

export function auditSummary(decision) {
  const rows = [
    ...decision.ignored.map((advisory) => [advisory, `Accepted until ${NODE_FORGE_EXCEPTION.expiresAt}`]),
    ...decision.blocking.map((advisory) => [advisory, "Blocking"])
  ];
  const lines = [
    "## Dependency security audit", "",
    decision.ok ? "Passed: no unaccepted high/critical findings." : "Failed: publishing must remain blocked.", "",
    "| Advisory | Package/version | Severity | Dependency path | Decision |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const [advisory, disposition] of rows) {
    const identity = advisoryIdentity(advisory);
    // Never turn an arbitrary registry URL into an executable or misleading link.
    const label = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(identity)
      ? `[${identity}](https://github.com/advisories/${identity})` : summaryText(identity);
    for (const finding of advisory.findings) {
      lines.push(`| ${label} | ${summaryText(`${advisory.module_name} ${finding.version}`)} | ${summaryText(advisory.severity)} | ${summaryText(finding.paths.join(", "))} | ${summaryText(disposition)} |`);
    }
  }
  if (!rows.length) lines.push("| — | — | — | — | No accepted or blocking findings available |");
  if (decision.errors.length) {
    lines.push("", "Audit errors:", "", ...decision.errors.map((error) => `- ${summaryText(error)}`));
  }
  if (decision.ignored.length) lines.push("", `Exception rationale: ${summaryText(NODE_FORGE_EXCEPTION.reason)}`);
  lines.push("", "Only high/critical findings determine this policy's result. The raw audit remains available with `pnpm run audit`.", "");
  return lines.join("\n");
}

export function auditExecutionDecision(audit, { now = Date.now() } = {}) {
  try {
    if (audit.error || audit.signal) {
      throw audit.error || new Error(`Dependency audit stopped with ${audit.signal}`);
    }
    return evaluateAudit(JSON.parse(audit.stdout), { auditExitCode: audit.status, now });
  } catch (error) {
    return { ok: false, errors: [`Dependency audit could not be completed: ${error.message}`], ignored: [], blocking: [] };
  }
}

export function reportAuditDecision(decision, {
  logger = console,
  githubActions = process.env.GITHUB_ACTIONS === "true",
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  appendSummary = appendFileSync
} = {}) {
  for (const error of decision.errors) logger.error(`Audit error: ${plainText(error)}`);
  for (const advisory of decision.blocking) logger.error(`Blocked dependency advisory: ${plainText(advisoryDetails(advisory))}.`);
  for (const advisory of decision.ignored) {
    logger.warn(`Accepted temporary exception: ${plainText(advisoryDetails(advisory))}; accepted until ${NODE_FORGE_EXCEPTION.expiresAt}.`);
  }
  if (githubActions) {
    for (const annotation of auditAnnotations(decision)) logger.log(annotation);
    if (summaryPath) appendSummary(summaryPath, auditSummary(decision), "utf8");
  }
  logger.log(decision.ok ? "Dependency audit passed." : "Dependency audit failed.");
}

export function runReleaseAudit({
  pnpmCli = process.env.npm_execpath,
  runAudit = spawnSync,
  now = Date.now(),
  ...reportOptions
} = {}) {
  let decision;
  try {
    // pnpm supplies its actual JavaScript CLI path to package scripts. Using
    // Node directly avoids shell interpolation and Windows .cmd wrappers.
    if (!pnpmCli || !/\.(?:cjs|mjs|js)$/i.test(pnpmCli)) {
      throw new Error("Run this check with pnpm run audit:release");
    }
    const audit = runAudit(process.execPath, [pnpmCli, "audit", "--json"], {
      cwd: root,
      shell: false,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true
    });
    decision = auditExecutionDecision(audit, { now });
  } catch (error) {
    decision = { ok: false, errors: [`Dependency audit could not be completed: ${error.message}`], ignored: [], blocking: [] };
  }
  reportAuditDecision(decision, reportOptions);
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!runReleaseAudit().ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Dependency audit could not be completed: ${plainText(error.message)}`);
    process.exitCode = 1;
  }
}
