import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
const result = await build({
  entryPoints: ["src/client/index.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
});
// DSH serves classic module-loader bundles, not bare browser ESM imports.
await writeFile(
  "lib/client.js",
  'window.__ModuleLoader__.load({id:"dsh-document-reader",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n' +
    result.outputFiles[0].text +
    "\nreturn module.exports;}});\n",
);
