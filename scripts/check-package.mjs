import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
// Git dependencies with build hooks need pnpm's separate Git-build approval,
// which DSH 0.2.1-alpha.1's ordinary dependency-script retry does not handle.
for (const hook of ["prepare", "prepack", "preinstall", "install", "postinstall"]) {
  assert.equal(manifest.scripts?.[hook], undefined, `${hook} must not run during UI installation`);
}
assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
assert.equal(manifest.dsh.client.platform, "web");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root, encoding: "utf8", shell: process.platform === "win32",
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || result.stdout);
const [pack] = JSON.parse(result.stdout);
const files = new Set(pack.files.map(({ path }) => path));
const required = [
  "package.json", manifest.main, manifest.types,
  manifest.exports["./client"].default.replace(/^\.\//, ""),
  manifest.exports["./client"].types.replace(/^\.\//, ""),
  "cordis.patch.yml", "LICENSE", "NOTICE",
  "THIRD_PARTY_NOTICES.md", "licenses/MarkItDown-MIT.txt", "licenses/Zod-MIT.txt",
  "python/markitdown_bridge.py", "python/stable_compat.py", "python/prepare_image.py",
  "python/requirements.txt", "python/constraints.lock", "python/upstream-hashes.json",
  "scripts/setup_python.py", "scripts/setup-python.ps1", "scripts/setup-python.sh", "scripts/secure-temp.ps1",
  "prompts/image-combined.txt", "prompts/image-description.txt", "prompts/image-transcription.txt",
];
for (const file of required) assert.ok(files.has(file), `Package is missing ${file}; run npm run build first`);
for (const file of files) {
  assert.ok(!/(^|\/)(node_modules|\.git|\.venv|__pycache__)(\/|$)/.test(file), `Unexpected private/generated dependency: ${file}`);
  assert.ok(!file.endsWith(".pyc"), `Unexpected Python cache: ${file}`);
}
const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
assert.ok(client.includes('window.__ModuleLoader__.load({id:"dsh-document-reader"'), "Client must use DSH's module loader");
console.log(`Package verified: ${manifest.name}@${manifest.version}, ${files.size} files, host/client and Python assets present, no install-time build hooks.`);
