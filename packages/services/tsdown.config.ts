import { pluginPackage } from '@pluxel/rolldown/build'
import { defineConfig } from 'vite-plus/pack'

const pluginBuild = pluginPackage({
	root: import.meta.dirname,
	packageMetadata: {
		packageJsonPath: `${import.meta.dirname}/package.json`,
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
	},
	deps: {
		neverBundle: [/^@pluxel\//],
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
		preset: './src/preset.ts',
		'internal/test': './src/internal-test.ts',
		vite: './src/vite.ts',
		sources: './src/sources.ts',

		'elysia/vite': './src/development/elysia.ts',
		'node/vite': './src/development/node.ts',

		internal: './src/internal.ts',
		'pg/pglite': './src/database/pg/pglite.ts',
		'pg/postgres': './src/database/pg/postgres.ts',
		pg: './src/pg.ts',
		sqlite: './src/sqlite.ts',
		'sqlite/libsql': './src/database/sqlite/libsql.ts',
		'sqlite/d1': './src/database/sqlite/d1.ts',
		'sqlite/d1/migrate': './src/database/sqlite/d1-migrate.ts',
		elysia: './src/elysia.ts',
		'elysia/node': './src/elysia-node.ts',
		node: './src/node.ts',
		workers: './src/workers.ts',
		commands: './src/commands.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})
