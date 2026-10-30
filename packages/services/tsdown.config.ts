import { pluginPackage } from '@pluxel/rolldown/build'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vite-plus/pack'

const require = createRequire(import.meta.url)
const coreRequire = createRequire(require.resolve('@zenfs/core'))
const bufferRequire = createRequire(require.resolve('buffer/'))
// Explicitly track the inlined filesystem closure and its original notices.
const bundledSources = [
	['@zenfs/core', dirname(dirname(require.resolve('@zenfs/core'))), ['LICENSE.md', 'COPYING.md']],
	['@zenfs/dom', dirname(dirname(require.resolve('@zenfs/dom'))), ['LICENSE.md', 'COPYING.md']],
	[
		'@zenfs/streams',
		dirname(dirname(coreRequire.resolve('@zenfs/streams'))),
		['LICENSE.md', 'COPYING.md'],
	],
	['kerium', dirname(dirname(require.resolve('kerium'))), ['README.md']],
	['utilium', dirname(dirname(coreRequire.resolve('utilium'))), ['LICENSE.md']],
	['memium', dirname(dirname(coreRequire.resolve('memium'))), ['LICENSE.md']],
	['eventemitter3', dirname(coreRequire.resolve('eventemitter3')), ['LICENSE']],
	['buffer', dirname(require.resolve('buffer/')), ['LICENSE']],
	['base64-js', dirname(bufferRequire.resolve('base64-js')), ['LICENSE']],
	['ieee754', dirname(bufferRequire.resolve('ieee754')), ['LICENSE']],
	['@noble/hashes', dirname(require.resolve('@noble/hashes/sha2.js')), ['LICENSE']],
] as const

const pluginBuild = pluginPackage({
	root: import.meta.dirname,
	packageMetadata: {
		packageJsonPath: `${import.meta.dirname}/package.json`,
		log: console.log,
	},
})

export default defineConfig({
	...pluginBuild,
	// ZenFS uses the npm Buffer implementation in browsers; keep it inside the artifact.
	alias: { buffer: require.resolve('buffer/') },
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
		alwaysBundle: [/^@zenfs\//, /^(?:@noble\/hashes|kerium|utilium)(?:\/|$)/],
		// The public Node-compatible signatures use Node's Buffer types, not npm buffer's declarations.
		dts: { neverBundle: ['buffer'] },
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
		fs: './src/fs.ts',
		'fs/browser': './src/fs/browser.ts',
		vault: './src/vault.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	copy: ({ outDir }) => [
		{ from: 'third-party/README.md', to: join(outDir, 'third-party') },
		{
			from: ['../../patches/@zenfs__core@2.8.3.patch', '../../patches/@zenfs__dom@1.2.14.patch'],
			to: join(outDir, 'third-party/patches'),
		},
		...bundledSources.map(([name, root, notices]) => ({
			from: ['package.json', ...notices].map((file) => join(root, file)),
			to: join(outDir, 'third-party', name),
		})),
	],
	clean: true,
	treeshake: true,
})
