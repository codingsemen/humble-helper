import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".pnpm-store",
  "artifacts",
  "dist",
  "node_modules",
  "release-artifacts",
  "web-ext-artifacts"
]);
const JavaScriptExtensions = new Set([".cjs", ".js", ".mjs"]);

async function findJavaScriptFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to check symbolic link: ${path.relative(root, path.join(directory, entry.name))}`);
    }

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await findJavaScriptFiles(path.join(directory, entry.name)));
      }
      continue;
    }

    if (entry.isFile() && JavaScriptExtensions.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files;
}

function checkSyntax(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", file], {
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
      reject(new Error(
        `${path.relative(root, file)} failed syntax validation${signal ? ` with ${signal}` : ` with exit code ${code}`}`
      ));
    });
  });
}

try {
  const files = (await findJavaScriptFiles(root)).sort();
  for (const file of files) {
    await checkSyntax(file);
  }
  process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
} catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
}
