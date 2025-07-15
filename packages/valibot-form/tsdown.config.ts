import { defineConfig } from 'tsdown'

export default defineConfig({
    entry: "./src/index.ts",
  dts: {
    sourcemap: true,
  },
  format: ['esm', 'cjs'],
  sourcemap: true,
  clean: true,
  minify: true,
  treeshake: true,
  external: ['valibot']
})