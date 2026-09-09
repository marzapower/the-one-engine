import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { N } from "../nums";
import { Engine } from "./engine";
import { applyPlugin, loadPlugin } from "./plugin-loader";
import { createSdk } from "./sdk";

describe("createSdk", () => {
  it("binds registry access to the engine it was built from", () => {
    const engine = new Engine();
    const sdk = createSdk(engine);

    expect(sdk.engine).toBe(engine);

    sdk.registerGrowth({ id: "sdk_growth", version: "1.0.0", compute: () => N(1), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } });
    expect(engine.growths.lookup("sdk_growth")).toBeDefined();
    expect(sdk.listGrowths()).toEqual(engine.growths.list());

    sdk.registerEffectType({ id: "sdk_effect", version: "1.0.0", priority: 100, apply: (prev) => ({ sign: prev.sign, layer: prev.layer, mag: prev.mag }) });
    expect(engine.effectTypes.lookup("sdk_effect")).toBeDefined();

    sdk.registerStage({ id: "SdkStage", version: "1.0.0", priority: 250, run: () => {} });
    expect(engine.stages.lookup("SdkStage")).toBeDefined();

    expect(sdk.unregisterGrowth("sdk_growth")).toBe(true);
    expect(engine.growths.lookup("sdk_growth")).toBeUndefined();
  });

  it("does not leak registrations to a different engine", () => {
    const engine = new Engine();
    const other = new Engine();
    const sdk = createSdk(engine);

    sdk.registerGrowth({ id: "only_here", version: "1.0.0", compute: () => N(0), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } });

    expect(engine.growths.lookup("only_here")).toBeDefined();
    expect(other.growths.lookup("only_here")).toBeUndefined();
  });

  it("exposes the numeric and schema utilities unbound", () => {
    const sdk = createSdk(new Engine());
    expect(sdk.N(5).toNumber()).toBe(5);
    expect(sdk.print(1000)).toBeTypeOf("string");
    expect(sdk.parseDataPack({ schemaVersion: "1.0.0", payload: null }).valid).toBe(true);
  });
});

describe("applyPlugin", () => {
  it("hands the plugin an SDK whose engine is the one applyPlugin was called with", async () => {
    const engine = new Engine();
    let seen: unknown;

    await applyPlugin(engine, (sdk) => {
      seen = sdk.engine;
    });

    expect(seen).toBe(engine);
  });
});

describe("loadPlugin", () => {
  function writePluginModule(id: string): string {
    const dir = mkdtempSync(join(tmpdir(), "engine-plugin-test-"));
    const file = join(dir, "plugin.mjs");
    writeFileSync(
      file,
      `export default function(sdk) {
        sdk.registerGrowth({ id: ${JSON.stringify(id)}, version: "1.0.0", compute: () => sdk.N(0), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } });
      };`,
    );
    return pathToFileURL(file).href;
  }

  it("loads a plugin module and registers its growth method", async () => {
    const engine = new Engine();
    const url = writePluginModule("loaded_once_growth");

    await loadPlugin(engine, url);

    expect(engine.growths.lookup("loaded_once_growth")).toBeDefined();
    expect(engine.plugins.has(url)).toBe(true);
  });

  it("running the same url twice applies the plugin only once", async () => {
    const engine = new Engine();
    const url = writePluginModule("idempotent_growth");

    await loadPlugin(engine, url);
    // If the module ran a second time, registerGrowth would throw on the duplicate id.
    await expect(loadPlugin(engine, url)).resolves.toBeUndefined();

    expect(engine.growths.lookup("idempotent_growth")).toBeDefined();
    expect(engine.plugins.size).toBe(1);
  });
});
