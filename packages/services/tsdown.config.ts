import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
		exclude: ['internal/database/pglite', 'internal/database/postgres'],
	},
	deps: { neverBundle: ['#pluxel/database-driver/pglite', '#pluxel/database-driver/postgres'] },
	entry: {
		'http/vite': './src/development/http.ts',
		'node/vite': './src/development/node.ts',

		index: './src/index.ts',
		internal: './src/internal.ts',
		'database/pglite': './src/database/pglite.ts',
		'database/postgres': './src/database/postgres.ts',
		database: './src/database.ts',
		'internal/database/pglite': './src/database/adapters/pglite.ts',
		'internal/database/postgres': './src/database/adapters/postgres.ts',
		http: './src/http.ts',
		'http/node': './src/http-node.ts',
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
