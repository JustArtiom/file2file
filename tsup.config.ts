import { defineConfig } from "tsup";

export default defineConfig({
  entry: [`backend`],
  splitting: true,
  silent: true,
  minify: process.env.NODE_ENV === `production`,
  clean: true,
  format: `cjs`,
  outDir: `dist_backend`,
});