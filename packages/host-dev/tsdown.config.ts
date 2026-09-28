import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: ['@pluxel/core', '@pluxel/rolldown', '@pluxel/rolldown/*', 'vite', 'vite/*'],
	},
	entry: {
		console: 'src/console.ts',
		internal: 'src/internal.ts',

		index: 'src/index.ts',
		vite: 'src/vite.ts',
	},
	dts: {
		// TS7's native declaration generator uses the config directory as rootDir. This root-level,
		// package-scoped config keeps intentional sibling source bridges inside that root so their
		// intermediate declarations stay in rolldown-plugin-dts's disposable output directory.
		tsconfig: '../../tsconfig.host-dev-dts.json',
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})
