import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
} from "@deepseek-ai/dsh-app-boot";

test("shipped manifest passes the installed DSH boot guard without a version exemption", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  // Exercise the real startup check, including optional host dependencies.
  assert.equal(getDshRuntimeVersion(), "0.2.1-alpha.1");
  assert.equal(evaluatePluginCompatibility(manifest, {}), undefined);
  // Versions before the new lower bound remain unsupported.
  const oldHost = evaluatePluginCompatibility(manifest, {}, "0.1.7-rc.2");
  assert.ok(oldHost);
  assert.equal(oldHost.exempted, false);
  assert.equal(Object.keys(oldHost.peers).length, 10);
});

test("DSH boot guard accepts the supported range and rejects both boundaries", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) =>
    name.startsWith("@deepseek-ai/dsh-"),
  );
  assert.equal(peers.length, 10);
  for (const [name, range] of peers) {
    assert.equal(range, ">=0.2.0-rc.2 <0.3.0-0", name);
    assert.equal(manifest.devDependencies[name], "0.2.1-alpha.1", name);
  }
  assert.equal(manifest.devDependencies["@deepseek-ai/cordis"], "4.0.5-alpha.1");
  for (const version of [
    "0.2.0-rc.2", "0.2.0-rc.3", "0.2.0", "0.2.1-alpha.1",
    "0.2.1", "0.2.2-alpha.1", "0.2.9",
  ]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version);
  }
  for (const version of [
    "0.1.7-rc.2", "0.2.0-alpha.1", "0.2.0-rc.1",
    "0.3.0-alpha.1", "0.3.0-rc.1", "0.3.0", "1.0.0",
  ]) {
    const result = evaluatePluginCompatibility(manifest, {}, version);
    assert.ok(result, version);
    assert.equal(result.exempted, false, version);
    assert.equal(Object.keys(result.peers).length, 10, version);
  }
});
