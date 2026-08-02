import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(root, "dist");
const targets = ["firefox", "chrome"];
const sourceEntries = [
  "background.js",
  "shared.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "options.html",
  "options.css",
  "options.js",
  "content",
  "icons"
];
async function assertNoSymbolicLinks(sourcePath) {
  const stats = await lstat(sourcePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to package symbolic link: ${path.relative(root, sourcePath)}`);
  }
  if (stats.isDirectory()) {
    const children = await readdir(sourcePath);
    await Promise.all(children.map((child) => assertNoSymbolicLinks(path.join(sourcePath, child))));
  }
}

await Promise.all([...sourceEntries, "manifest.json", "package.json"].map((entry) =>
  assertNoSymbolicLinks(path.join(root, entry))
));

const firefoxManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (firefoxManifest.version !== packageMetadata.version) {
  throw new Error("manifest.json and package.json versions must match");
}

try {
  const distStats = await lstat(distRoot);
  if (distStats.isSymbolicLink()) {
    throw new Error("Refusing to replace a dist directory that is a symbolic link");
  }
} catch (error) {
  if (error && error.code !== "ENOENT") {
    throw error;
  }
}

await rm(distRoot, { recursive: true, force: true });
await Promise.all(targets.map((target) => mkdir(path.join(distRoot, target), { recursive: true })));

for (const target of targets) {
  for (const entry of sourceEntries) {
    await cp(path.join(root, entry), path.join(distRoot, target, entry), { recursive: true });
  }
}

const chromeManifest = structuredClone(firefoxManifest);
delete chromeManifest.browser_specific_settings;
chromeManifest.minimum_chrome_version = "120";
chromeManifest.background = { service_worker: "background.js" };

await writeFile(
  path.join(distRoot, "firefox", "manifest.json"),
  JSON.stringify(firefoxManifest, null, 2) + "\n"
);
await writeFile(
  path.join(distRoot, "chrome", "manifest.json"),
  JSON.stringify(chromeManifest, null, 2) + "\n"
);

process.stdout.write("Prepared Firefox and Chrome extension sources.\n");
