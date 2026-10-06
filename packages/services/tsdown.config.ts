import { pluginPackage } from '@pluxel/rolldown/build'
import { defineConfig } from 'tsdown'

const pluginBuild = pluginPackage({
	root: import.meta.dirname,
	packageMetadata: {
		packageJsonPath: `${import.meta.dirname}/package.json`,
		manifestField: 'pluxel',
		log: console.log,
	},
})

export default defineConfig({
	...pluginBuild,
	exports: {
		devExports: '@pluxel/source',
		customExports(exports, { isPublish }) {
			if (!isPublish)
				exports['./plugins'] = { '@pluxel/hmr': './src/plugins.ts', default: './dist/plugins.mjs' }
			return exports
		},
		exclude: ['internal/database/pglite', 'internal/database/postgres'],
	},
	deps: {
		neverBundle: [
			/^@pluxel\//,
			'#pluxel/database-driver/pglite',
			'#pluxel/database-driver/postgres',
		],
	},
	entry: {
		plugins: './src/plugins.ts',
		management: './src/management/index.ts',
		'management/client': './src/management/client.ts',
		'management/protocol': './src/management/protocol.ts',
		'management/react': './src/management/react.ts',
		'management/session': './src/management/web/session/index.ts',
		'management/product': './src/management/product-contract.ts',
		'management/access': './src/management/access.ts',
		'management/service': './src/management/service.ts',
		'management/http': './src/management/http.ts',
		'management/commands': './src/management/commands.ts',
		'management/internal': './src/management/internal.ts',
		'management/internal/http': './src/management/http-internal.ts',
		'management/internal/test': './src/management/test-internal.ts',
		logging: './src/logging/index.ts',
		'logging/internal': './src/logging/internal.ts',
		'logging/protocol': './src/logging/protocol.ts',
		preset: './src/preset.ts',
		'internal/test': './src/internal-test.ts',
		vite: './src/vite.ts',
		sources: './src/sources.ts',

		'elysia/vite': './src/development/elysia.ts',
		'node/vite': './src/development/node.ts',

		index: './src/index.ts',
		internal: './src/internal.ts',
		'database/pglite': './src/database/pglite.ts',
		'database/postgres': './src/database/postgres.ts',
		database: './src/database.ts',
		'internal/database/pglite': './src/database/adapters/pglite.ts',
		'internal/database/postgres': './src/database/adapters/postgres.ts',
		elysia: './src/elysia.ts',
		'elysia/node': './src/elysia-node.ts',
		node: './src/node.ts',
		workers: './src/workers.ts',
		commands: './src/commands.ts',
		persistence: './src/persistence.ts',
		vault: './src/vault.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})
