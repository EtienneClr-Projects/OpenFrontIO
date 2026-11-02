import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const result = await build({
  configFile: false,
  root,
  logLevel: "silent",
  resolve: {
    alias: { "@openfront/engine-api": `${root}packages/engine-api/src` },
  },
  build: {
    write: false,
    minify: false,
    target: "es2022",
    lib: {
      entry: `${root}chrome-extension/tests/observer.scenarios.ts`,
      formats: ["es"],
      fileName: () => "scenarios.js",
    },
    rolldownOptions: { external: ["node:test", "node:assert/strict"] },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output.find(
  (item) => item.type === "chunk",
);
await import(
  `data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`
);
