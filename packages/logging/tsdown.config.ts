import { defineConfig } from 'tsdown'
export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: { index: './src/index.ts', internal: './src/internal.ts', protocol: './src/protocol.ts' },
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})
