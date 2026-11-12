// Standalone build: no Vite game configuration or game runtime entry is loaded.
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
await build({
  configFile: false,
  root,
  plugins: [
    {
      name: "reference-game-enums",
      enforce: "pre",
      transform(source, id) {
        if (id === `${root}packages/engine-api/src/game/GameUpdates.ts`) {
          const parsed = parseSync(id, source);
          if (parsed.errors.length)
            throw new Error("Cannot parse GameUpdates.");
          const entry = parsed.program.body.find(
            (node) =>
              node.type === "ExportNamedDeclaration" &&
              node.declaration?.type === "TSEnumDeclaration" &&
              node.declaration.id.name === "GameUpdateType",
          );
          if (!entry) throw new Error("Reference game update enum changed.");
          return { code: source.slice(entry.start, entry.end), map: null };
        }
        if (id !== `${root}packages/engine-api/src/game/GameTypes.ts`) return;
        // This module also initializes the map catalog. Extract the exact
        // reference enums at build time instead of shipping unrelated catalogs.
        const names = new Set(["GameMode", "PlayerType", "UnitType"]);
        const parsed = parseSync(id, source);
        if (parsed.errors.length)
          throw new Error("Cannot parse reference GameTypes.");
        const enums = parsed.program.body.filter(
          (node) =>
            node.type === "ExportNamedDeclaration" &&
            node.declaration?.type === "TSEnumDeclaration" &&
            names.has(node.declaration.id.name),
        );
        if (enums.length !== names.size)
          throw new Error("Reference game enums changed.");
        return {
          code: enums
            .map((node) => source.slice(node.start, node.end))
            .join("\n"),
          map: null,
        };
      },
      generateBundle(_options, bundle) {
        const allowed = new Set([
          `${root}chrome-extension/src/Main.ts`,
          `${root}chrome-extension/src/Observer.ts`,
          `${root}chrome-extension/src/Strategy.ts`,
          `${root}src/client/advisor/GamePhase.ts`,
          `${root}src/client/advisor/SpatialIndex.ts`,
          `${root}packages/engine-api/src/game/GameTypes.ts`,
          `${root}packages/engine-api/src/game/GameUpdates.ts`,
        ]);
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk")
            throw new Error("Unexpected extension build asset.");
          if (output.imports.length || output.dynamicImports.length)
            throw new Error("Extension must be self-contained.");
          for (const id of Object.keys(output.modules)) {
            if (!allowed.has(id))
              throw new Error(`Unexpected advisor runtime dependency: ${id}`);
          }
        }
      },
    },
  ],
  resolve: {
    alias: { "@openfront/engine-api": `${root}packages/engine-api/src` },
  },
  build: {
    outDir: `${root}chrome-extension/openfront-overlay`,
    emptyOutDir: false,
    target: "chrome111",
    minify: false,
    lib: {
      entry: `${root}chrome-extension/src/Main.ts`,
      name: "OpenFrontOverlay",
      formats: ["iife"],
      fileName: () => "inject.js",
    },
  },
});
