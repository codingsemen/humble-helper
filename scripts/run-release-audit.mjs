import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAudit, NODE_FORGE_EXCEPTION } from "./release-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  // pnpm supplies its actual JavaScript CLI path to package scripts. Using
  // Node directly avoids shell interpolation and Windows .cmd wrappers.
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !/\.(?:cjs|mjs|js)$/i.test(pnpmCli)) {
    throw new Error("Run this check with pnpm run audit:release");
  }
  const audit = spawnSync(process.execPath, [pnpmCli, "audit", "--json"], {
    cwd: root,
    shell: false,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true
  });
  if (audit.error || audit.signal) {
    throw audit.error || new Error(`Dependency audit stopped with ${audit.signal}`);
  }
  const decision = evaluateAudit(JSON.parse(audit.stdout), { auditExitCode: audit.status });
  for (const error of decision.errors) console.error(error);
  for (const advisory of decision.blocking) {
    console.error(`Blocked dependency advisory: ${JSON.stringify(advisory)}`);
  }
  if (decision.ignored.length) {
    console.warn(`Temporary exception: ${NODE_FORGE_EXCEPTION.id}; expires ${NODE_FORGE_EXCEPTION.expiresAt}.`);
    console.warn("The weekly security scan still reports this unpatched Android build-tool dependency.");
  }
  if (!decision.ok) {
    process.exitCode = 1;
  } else {
    console.log("Release dependency audit passed.");
  }
} catch (error) {
  console.error(`Release dependency audit could not be completed: ${error.message}`);
  process.exitCode = 1;
}
