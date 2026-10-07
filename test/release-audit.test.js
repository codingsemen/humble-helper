const assert = require("node:assert/strict");
const test = require("node:test");

const policy = import("../scripts/release-audit.mjs");
const runner = import("../scripts/run-release-audit.mjs");
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

function diagnosticRecorder() {
  const output = [];
  const summaries = [];
  return {
    output,
    summaries,
    options: {
      githubActions: true,
      summaryPath: "/runner/audit-summary.md",
      logger: Object.fromEntries(["log", "warn", "error"].map((method) => [method, (value) => output.push([method, value])])),
      appendSummary: (...args) => summaries.push(args)
    }
  };
}

test("audit runner keeps the accepted advisory visible as a passing warning and step summary", async () => {
  const { runReleaseAudit } = await runner;
  const diagnostic = diagnosticRecorder();
  const invocation = [];
  const decision = runReleaseAudit({
    ...diagnostic.options,
    pnpmCli: "/pnpm/pnpm.cjs",
    now: beforeExpiry,
    runAudit: (...args) => {
      invocation.push(args);
      return { status: 1, stdout: JSON.stringify(reportOf(nodeForge())) };
    }
  });
  assert.equal(decision.ok, true);
  assert.equal(invocation[0][0], process.execPath);
  assert.deepEqual(invocation[0][1], ["/pnpm/pnpm.cjs", "audit", "--json"]);
  assert.equal(invocation[0][2].shell, false);
  assert.equal(diagnostic.output.filter(([, value]) => value.startsWith("::warning::")).length, 1);
  const warning = diagnostic.output.find(([, value]) => value.startsWith("::warning::"))[1];
  for (const detail of ["GHSA-86w9-cpqp-85rv", "node-forge 1.4.0", "high", ".>web-ext>@devicefarmer/adbkit>node-forge", "2026-11-06T00:00:00Z"]) {
    assert.ok(warning.includes(detail));
  }
  assert.equal(diagnostic.summaries.length, 1);
  assert.equal(diagnostic.summaries[0][0], "/runner/audit-summary.md");
  assert.match(diagnostic.summaries[0][1], /\[GHSA-86w9-cpqp-85rv\]\(https:\/\/github\.com\/advisories\/GHSA-86w9-cpqp-85rv\)/);
  assert.match(diagnostic.summaries[0][1], /Accepted until 2026-11-06T00:00:00Z/);
  assert.match(diagnostic.summaries[0][1], /Passed: no unaccepted high\/critical findings/);
  assert.equal(diagnostic.summaries[0][2], "utf8");
});

test("audit runner fails unexpected high findings while preserving the accepted warning", async () => {
  const { runReleaseAudit } = await runner;
  const diagnostic = diagnosticRecorder();
  const decision = runReleaseAudit({
    ...diagnostic.options,
    pnpmCli: "/pnpm/pnpm.cjs",
    now: beforeExpiry,
    runAudit: () => ({ status: 1, stdout: JSON.stringify(reportOf(nodeForge(), nodeForge({
      module_name: "another-package", github_advisory_id: "GHSA-1234-abcd-1234", url: "https://github.com/advisories/GHSA-1234-abcd-1234"
    }))) })
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.ignored.length, 1);
  assert.equal(decision.blocking.length, 1);
  assert.ok(diagnostic.output.some(([, value]) => value.startsWith("::error::") && value.includes("another-package")));
  assert.ok(diagnostic.output.some(([, value]) => value.startsWith("::warning::")));
  assert.match(diagnostic.summaries[0][1], /another-package 1\.4\.0.*Blocking/);
  assert.match(diagnostic.summaries[0][1], /Failed: publishing must remain blocked/);
});

test("audit runner blocks the expired exception without reporting it as accepted", async () => {
  const { runReleaseAudit } = await runner;
  const diagnostic = diagnosticRecorder();
  const decision = runReleaseAudit({
    ...diagnostic.options, pnpmCli: "/pnpm/pnpm.cjs", now: expiry,
    runAudit: () => ({ status: 1, stdout: JSON.stringify(reportOf(nodeForge())) })
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.ignored.length, 0);
  assert.equal(diagnostic.output.some(([, value]) => value.startsWith("::warning::")), false);
  assert.match(diagnostic.summaries[0][1], /exception expired at 2026-11-06T00:00:00Z/);
  assert.match(diagnostic.summaries[0][1], /node-forge 1\.4\.0.*Blocking/);
});

test("audit runner blocks malformed JSON, inconsistent reports, audit errors, and tool failures", async () => {
  const { auditExecutionDecision } = await runner;
  for (const execution of [
    { status: 0, stdout: "not JSON" },
    { status: 1, stdout: JSON.stringify({ error: { code: "ENETUNREACH" } }) },
    { status: 0, stdout: JSON.stringify(reportOf(nodeForge())) },
    { status: 2, stdout: JSON.stringify(reportOf()) },
    { status: null, stdout: "", error: new Error("Audit timed out") },
    { status: null, stdout: "", signal: "SIGTERM" }
  ]) {
    const decision = auditExecutionDecision(execution, { now: beforeExpiry });
    assert.equal(decision.ok, false);
    assert.ok(decision.errors.length > 0);
    assert.equal(decision.ignored.length, 0);
  }
});

test("audit diagnostics cannot inject workflow commands or arbitrary summary links", async () => {
  const { auditAnnotations, auditSummary, reportAuditDecision } = await runner;
  const malicious = nodeForge({
    module_name: "bad|[package](https://evil.example)\r\n::notice::injected",
    github_advisory_id: undefined,
    url: "javascript:alert(1)",
    title: "[title](https://evil.example)\n::error::injected",
    findings: [{ version: "1.4.0%\n", paths: ["<script>|`\n::warning::injected"] }]
  });
  const decision = { ok: false, errors: ["Bad report%\r\n::notice::injected"], ignored: [], blocking: [malicious] };
  const diagnostic = diagnosticRecorder();
  reportAuditDecision(decision, diagnostic.options);
  for (const annotation of auditAnnotations(decision)) {
    assert.equal(annotation.includes("\n"), false);
    assert.equal(annotation.includes("\r"), false);
    assert.match(annotation, /%0A/);
  }
  assert.ok(auditAnnotations(decision).some((annotation) => annotation.includes("%25")));
  for (const [, message] of diagnostic.output) assert.equal(/[\r\n]/.test(message), false);
  const summary = auditSummary(decision);
  assert.equal(summary.includes("javascript:"), false);
  assert.equal(summary.includes("[title](https://evil.example)"), false);
  assert.equal(summary.includes("<script>"), false);
  assert.match(summary, /&#91;title&#93;/);
  assert.match(summary, /&lt;script&gt;&#124;&#96;/);
});

test("local audits retain readable diagnostics without GitHub annotations or file writes", async () => {
  const { reportAuditDecision } = await runner;
  const { evaluateAudit } = await policy;
  const diagnostic = diagnosticRecorder();
  reportAuditDecision(evaluateAudit(reportOf(nodeForge()), { auditExitCode: 1, now: beforeExpiry }), {
    ...diagnostic.options, githubActions: false
  });
  assert.equal(diagnostic.summaries.length, 0);
  assert.equal(diagnostic.output.some(([, value]) => value.startsWith("::")), false);
  assert.ok(diagnostic.output.some(([method, value]) => method === "warn" && value.includes("accepted until")));
});

test("audit runner fails missing pnpm CLI and does not silently suppress summary write failures", async () => {
  const { runReleaseAudit } = await runner;
  const diagnostic = diagnosticRecorder();
  const missing = runReleaseAudit({ ...diagnostic.options, pnpmCli: "pnpm.cmd", runAudit: () => assert.fail("must not run") });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /pnpm run audit:release/);
  assert.throws(() => runReleaseAudit({
    ...diagnostic.options, pnpmCli: "/pnpm/pnpm.cjs", now: beforeExpiry,
    runAudit: () => ({ status: 0, stdout: JSON.stringify(reportOf()) }),
    appendSummary: () => { throw new Error("Cannot write summary"); }
  }), /Cannot write summary/);
});
