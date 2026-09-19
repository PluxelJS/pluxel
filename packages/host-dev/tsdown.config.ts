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
		'internal/dev/console': 'src/dev/console.ts',

		'internal/vite-urls': 'src/internal/vite-urls.ts',
		'internal/update-error': 'src/internal/update-error.ts',
		'internal/console/attachment': 'src/console/attachment.ts',
		'internal/console/server': 'src/console/server.ts',
		'internal/console/protocol': 'src/console/protocol.ts',
		'internal/console/executor': 'src/console/executor.ts',
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
