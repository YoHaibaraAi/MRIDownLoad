import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const manifestText = JSON.stringify(manifest);
if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3");
if (manifestText.includes("<all_urls>")) throw new Error("Forbidden <all_urls> permission found");
if (/webRequestBlocking|debugger|cookies/.test(manifestText)) throw new Error("Unnecessary privileged permission found");

const sourceFiles = fs.readdirSync(path.join(root, "src")).map((name) => path.join(root, "src", name));
for (const file of sourceFiles) {
  const content = fs.readFileSync(file, "utf8");
  if (/https?:\/\//i.test(content)) throw new Error(`Remote URL found in runtime source: ${file}`);
  if (/[0-9a-f]{32,}/i.test(content)) throw new Error(`Potential hard-coded token/key in runtime source: ${file}`);
}

const allowedMatch = "https://hos-turn-service.rwjiankang.com:5447/*";
const matches = manifest.content_scripts.flatMap((entry) => entry.matches || []);
if (matches.some((match) => match !== allowedMatch)) throw new Error("Unexpected content-script host match found");

const referenced = manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]);
for (const relative of referenced) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Manifest file is missing: ${relative}`);
}

console.log("Static checks passed: MV3 manifest, minimal permissions, local assets, no hard-coded key in runtime.");
