import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: ['@pluxel/core', '@pluxel/rolldown', '@pluxel/rolldown/*', 'vite', 'vite/*'],
	},
	entry: {
		'internal/update-error': 'src/internal/update-error.ts',
		http: 'src/http.ts',
		'internal/vite-node-carrier': 'src/internal/vite-node-carrier.ts',
		console: 'src/console.ts',
		'internal/dev/logs': 'src/dev/logs.ts',
		'internal/dev/contracts': 'src/dev/contracts.ts',
		'internal/dev/workbench': 'src/dev/workbench.ts',
		'internal/dev/dependencies': 'src/dev/dependencies.ts',
		'internal/dev/forks': 'src/dev/forks.ts',
		'internal/dev/scope': 'src/dev/scope.ts',
		'internal/dev/console': 'src/dev/console.ts',
		'internal/console/attachment': 'src/console/attachment.ts',
		'internal/console/server': 'src/console/server.ts',
		'internal/console/protocol': 'src/console/protocol.ts',
		'internal/console/executor': 'src/console/executor.ts',
		index: 'src/index.ts',
		'hmr-log': 'src/hmr-log.ts',
		vite: 'src/vite.ts',
		node: 'src/node.ts',
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
