import { defineConfig } from 'vite-plus/pack'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const zenfsRequire = createRequire(require.resolve('@zenfs/core'))
const bufferRequire = createRequire(require.resolve('buffer/'))
// The patched filesystem implementation and its notices travel with the Core artifact.
const bundledSources = [
	['@zenfs/core', dirname(dirname(require.resolve('@zenfs/core'))), ['LICENSE.md', 'COPYING.md']],
	['@zenfs/dom', dirname(dirname(require.resolve('@zenfs/dom'))), ['LICENSE.md', 'COPYING.md']],
	[
		'@zenfs/streams',
		dirname(dirname(zenfsRequire.resolve('@zenfs/streams'))),
		['LICENSE.md', 'COPYING.md'],
	],
	['kerium', dirname(dirname(require.resolve('kerium'))), ['README.md']],
	['utilium', dirname(dirname(zenfsRequire.resolve('utilium'))), ['LICENSE.md']],
	['memium', dirname(dirname(zenfsRequire.resolve('memium'))), ['LICENSE.md']],
	['eventemitter3', dirname(zenfsRequire.resolve('eventemitter3')), ['LICENSE']],
	['buffer', dirname(require.resolve('buffer/')), ['LICENSE']],
	['base64-js', dirname(bufferRequire.resolve('base64-js')), ['LICENSE']],
	['ieee754', dirname(bufferRequire.resolve('ieee754')), ['LICENSE']],
	['@noble/hashes', dirname(require.resolve('@noble/hashes/sha2.js')), ['LICENSE']],
] as const

const transformOptions = {
	assumptions: {
		setPublicClassFields: true,
	},
	typescript: {
		removeClassFieldsWithoutInitializer: true,
	},
}

export default defineConfig({
	deps: {
		onlyBundle: [
			'option-t',
			/^@zenfs\//,
			/^(?:@noble\/hashes|kerium|utilium|memium|eventemitter3|buffer|base64-js|ieee754)(?:\/|$)/,
		],
		alwaysBundle: [
			'@pluxel/context',
			'@pluxel/context/*',
			'eventure',
			/^@zenfs\//,
			/^(?:@noble\/hashes|kerium|utilium|memium|eventemitter3|buffer|base64-js|ieee754)(?:\/|$)/,
		],
		// Public filesystem signatures retain the platform's Node-compatible Buffer types.
		dts: { neverBundle: ['buffer'] },
	},
	alias: { buffer: require.resolve('buffer/') },
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		config: 'src/config.ts',
		logging: 'src/logging.ts',
		'logging/internal': 'src/logging/internal.ts',
		'logging/protocol': 'src/logging/protocol.ts',
		'logging/pretty': 'src/logging/pretty.ts',
		federation: 'src/federation.ts',
		internal: 'src/internal.ts',
		'internal/test': 'src/internal-test.ts',
		index: 'src/index.ts',
		host: 'src/host.ts',
		services: 'src/services/index.ts',
		logger: 'src/logger/index.ts',
		'better-result': 'src/better-result.ts',
		toolchain: 'src/toolchain.ts',
		fs: 'src/fs.ts',
		'fs/browser': 'src/fs/browser.ts',
	},
	dts: {
		// Context declarations are bundled from workspace source outside Core's tsconfig root.
		eager: true,
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
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
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions(options) {
		// Keep direct Core builds independent of a pre-existing @pluxel/context dist directory.
		options.resolve = {
			...options.resolve,
			conditionNames: ['@pluxel/source', 'import', 'node', 'default'],
		}
		options.transform = {
			...options.transform,
			...transformOptions,
		}
	},
})
