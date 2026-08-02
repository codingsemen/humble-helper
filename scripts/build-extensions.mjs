import { access, lstat, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allTargets = ["firefox", "chrome"];
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length ? [...new Set(requestedTargets)] : allTargets;

if (targets.some((target) => !allTargets.includes(target))) {
  console.error("Usage: node scripts/build-extensions.mjs [firefox] [chrome]");
  process.exitCode = 1;
} else {
  const webExtBin = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");

  function runWebExt(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [webExtBin, ...args], {
        cwd: root,
        shell: false,
        stdio: "inherit",
        windowsHide: true
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`web-ext ${args[0]} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
      });
    });
  }

  async function resetArtifactDirectory(target) {
    const artifactDirectory = path.join(root, "artifacts", target);
    try {
      const stats = await lstat(artifactDirectory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Refusing to replace artifacts/${target} because it is not a regular directory`);
      }
      await rm(artifactDirectory, { recursive: true });
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(artifactDirectory, { recursive: true });
  }

  try {
    await access(webExtBin);
    await import("./prepare-build.mjs");
    await Promise.all(targets.map(resetArtifactDirectory));

    if (targets.includes("firefox")) {
      await runWebExt([
        "lint",
        "--source-dir",
        path.join("dist", "firefox"),
        "--warnings-as-errors"
      ]);
    }

    for (const target of targets) {
      console.log(`Building ${target} extension...`);
      await runWebExt([
        "build",
        "--source-dir",
        path.join("dist", target),
        "--artifacts-dir",
        path.join("artifacts", target),
        "--overwrite-dest"
      ]);
    }

    console.log("Build complete:");
    for (const target of targets) {
      console.log(`  dist/${target}/`);
      console.log(`  artifacts/${target}/`);
    }
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    console.error("If a browser is using an unpacked build, close or reload it before rebuilding dist/.");
    process.exitCode = 1;
  }
}
