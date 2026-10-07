const assert = require("node:assert/strict");
const test = require("node:test");

const policy = import("../scripts/release-audit.mjs");
const beforeExpiry = Date.parse("2026-10-07T12:00:00Z");
const expiry = Date.parse("2026-11-06T00:00:00Z");

function nodeForge(overrides = {}) {
  return {
    module_name: "node-forge",
    severity: "high",
    title: "RSA PKCS#1 v1.5 signature verification forgery",
    github_advisory_id: "GHSA-86w9-cpqp-85rv",
    url: "https://github.com/advisories/GHSA-86w9-cpqp-85rv",
    findings: [{
      version: "1.4.0",
      paths: [".>web-ext>@devicefarmer/adbkit>node-forge"],
      dev: true,
      optional: false,
      bundled: false
    }],
    ...overrides
  };
}

function reportOf(...advisories) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const advisory of advisories) vulnerabilities[advisory.severity] += 1;
  return {
    advisories: Object.fromEntries(advisories.map((advisory, index) => [index, advisory])),
    metadata: { vulnerabilities }
  };
}

test("release audit accepts a complete clean report, including after exception expiry", async () => {
  const { evaluateReleaseAudit } = await policy;
  assert.deepEqual(evaluateReleaseAudit(reportOf(), 0, expiry), {
    acceptedExceptions: [], blockingAdvisories: []
  });
});

test("release audit wrapper provides runner diagnostics without throwing", async () => {
  const { evaluateAudit, NODE_FORGE_EXCEPTION } = await policy;
  assert.equal(NODE_FORGE_EXCEPTION.id, "GHSA-86w9-cpqp-85rv");
  const advisory = nodeForge();
  const accepted = evaluateAudit(reportOf(advisory), { auditExitCode: 1, now: beforeExpiry });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.ignored, [advisory]);
  const blocked = evaluateAudit(reportOf(advisory), { auditExitCode: 1, now: expiry });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blocking, [advisory]);
  assert.match(blocked.errors[0], /exception expired/);
  assert.equal(evaluateAudit({ error: {} }, { auditExitCode: 1, now: beforeExpiry }).ok, false);
});

test("release audit accepts only the approved development finding before expiry", async () => {
  const { evaluateReleaseAudit } = await policy;
  const advisory = nodeForge();
  assert.deepEqual(evaluateReleaseAudit(reportOf(advisory), 1, beforeExpiry).acceptedExceptions, [advisory]);
  assert.equal(evaluateReleaseAudit(reportOf(advisory), 1, expiry - 1).acceptedExceptions.length, 1);
  assert.throws(() => evaluateReleaseAudit(reportOf(advisory), 1, expiry), /exception expired/);
});

test("release audit recognizes either exact GHSA identity without accepting contradictory identity", async () => {
  const { evaluateReleaseAudit } = await policy;
  for (const advisory of [nodeForge({ url: undefined }), nodeForge({ github_advisory_id: undefined })]) {
    assert.equal(evaluateReleaseAudit(reportOf(advisory), 1, beforeExpiry).acceptedExceptions.length, 1);
  }
  for (const advisory of [
    nodeForge({ url: "https://github.com/advisories/GHSA-other" }),
    nodeForge({ github_advisory_id: "GHSA-other" })
  ]) {
    assert.throws(() => evaluateReleaseAudit(reportOf(advisory), 1, beforeExpiry), /Release blocked/);
  }
});

test("release audit blocks another advisory even when the approved finding is also present", async () => {
  const { evaluateReleaseAudit } = await policy;
  for (const severity of ["high", "critical"]) {
    const other = nodeForge({ module_name: "new-package", severity, github_advisory_id: "GHSA-new", url: "https://github.com/advisories/GHSA-new" });
    assert.throws(() => evaluateReleaseAudit(reportOf(nodeForge(), other), 1, beforeExpiry), /new-package/);
  }
});

test("release audit blocks changed package, version, path, severity, or deployment scope", async () => {
  const { evaluateReleaseAudit } = await policy;
  const original = nodeForge();
  const finding = original.findings[0];
  const variations = [
    nodeForge({ module_name: "another-package" }),
    nodeForge({ severity: "critical" }),
    nodeForge({ findings: [{ ...finding, version: "1.4.1" }] }),
    nodeForge({ findings: [{ ...finding, paths: [".>node-forge"] }] }),
    nodeForge({ findings: [{ ...finding, paths: [...finding.paths, ".>other>node-forge"] }] }),
    nodeForge({ findings: [finding, { ...finding, version: "1.3.1" }] }),
    nodeForge({ findings: [{ ...finding, dev: false }] }),
    nodeForge({ findings: [{ ...finding, bundled: true }] }),
    nodeForge({ findings: [{ ...finding, optional: true }] })
  ];
  for (const advisory of variations) {
    assert.throws(() => evaluateReleaseAudit(reportOf(advisory), 1, beforeExpiry), /Release blocked/);
  }
});

test("release audit preserves the existing high severity threshold", async () => {
  const { evaluateReleaseAudit } = await policy;
  const result = evaluateReleaseAudit(reportOf(nodeForge({ severity: "moderate" })), 1, beforeExpiry);
  assert.deepEqual(result, { acceptedExceptions: [], blockingAdvisories: [] });
});

test("release audit rejects tool failures and network error payloads", async () => {
  const { evaluateReleaseAudit } = await policy;
  for (const status of [2, -1, null, undefined, "0"]) {
    assert.throws(() => evaluateReleaseAudit(reportOf(), status, beforeExpiry), /failed to run/);
  }
  assert.throws(() => evaluateReleaseAudit({ error: { code: "ENETUNREACH" } }, 1, beforeExpiry), /returned an error/);
  assert.throws(() => evaluateReleaseAudit({ ...reportOf(), error: {} }, 0, beforeExpiry), /returned an error/);
});

test("release audit rejects incomplete, malformed, or inconsistent reports", async () => {
  const { evaluateReleaseAudit } = await policy;
  for (const report of [null, [], {}, { advisories: [] }, { advisories: {}, metadata: {} }]) {
    assert.throws(() => evaluateReleaseAudit(report, 0, beforeExpiry));
  }
  const missingFinding = reportOf(nodeForge({ findings: [] }));
  assert.throws(() => evaluateReleaseAudit(missingFinding, 1, beforeExpiry), /invalid advisory/);
  const concealedFinding = reportOf(nodeForge());
  concealedFinding.advisories = {};
  assert.throws(() => evaluateReleaseAudit(concealedFinding, 0, beforeExpiry), /total does not match/);
  assert.throws(() => evaluateReleaseAudit(reportOf(nodeForge()), 0, beforeExpiry), /exit code does not match/);
  assert.throws(() => evaluateReleaseAudit(reportOf(), 1, beforeExpiry), /exit code does not match/);
  assert.throws(() => evaluateReleaseAudit(reportOf(), 0, NaN), /invalid date/);
});
