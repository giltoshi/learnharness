import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const OUT = "C:/Users/danie/OneDrive/Alyx 1.0/.obsidian/plugins/learnharness";
// The fork this plugin ships with: the default server location, baked at build time.
const REPO = resolve(import.meta.dirname, "..").replaceAll("\\", "/");
const watch = process.argv.includes("--watch");

mkdirSync(OUT, { recursive: true });

const copyStatic = {
  name: "copy-static",
  setup(build) {
    build.onEnd(() => {
      copyFileSync("manifest.json", join(OUT, "manifest.json"));
      copyFileSync("styles.css", join(OUT, "styles.css"));
      writeFileSync(join(OUT, ".hotreload"), "");
      console.log("[build] wrote bundle, manifest, styles.css and .hotreload");
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  outfile: join(OUT, "main.js"),
  external: ["obsidian", "electron", ...builtins],
  define: { __LH_REPO__: JSON.stringify(REPO) },
  plugins: [copyStatic],
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
