import type { Engine } from "./engine";
import { type EngineSdk, createSdk } from "./sdk";

/**
 * A plugin registers growth methods, effect types or stages on the SDK it
 * receives. It has no other way to reach the engine.
 */
export type Plugin = (sdk: EngineSdk) => void | Promise<void>;

/** Runs `plugin` against `engine`'s own SDK. */
export async function applyPlugin(engine: Engine, plugin: Plugin): Promise<void> {
  await plugin(createSdk(engine));
}

/**
 * Dynamically imports the module at `url` and applies it as a plugin: its
 * default export, or its `applyPlugin` export. A no-op when `url` is already
 * in `engine.plugins`; added to it on success.
 */
export async function loadPlugin(engine: Engine, url: string): Promise<void> {
  if (engine.plugins.has(url)) return;

  const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as { default?: Plugin; applyPlugin?: Plugin };
  const plugin = mod.default ?? mod.applyPlugin;
  if (typeof plugin !== "function") {
    throw new Error(`Plugin at ${url}: missing default export "(sdk) => void"`);
  }

  await applyPlugin(engine, plugin);
  engine.plugins.add(url);
}
