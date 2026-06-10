import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const buildRoot = fileURLToPath(new URL('../build/src/index.ts', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))
const runtimeLoaderRegister = fileURLToPath(new URL('./src/register.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		// Internal/private workspace packages must be bundled into the published artifact.
		alwaysBundle: [
			'@pluxel/build',
			'@pluxel/build/*',
			'@pluxel/workspace/fs',
			'@pluxel/workspace/info',
		],
		onlyBundle: ['fdir'],
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/services',
			'@pluxel/runtime',
			'@pluxel/runtime/internal',
			'@pluxel/runtime/plugin-catalog',
			'@pluxel/runtime/shared',
			'vite',
			'vite/*',
		],
	},
	alias: {
		'@pluxel/build': buildRoot,
		'@pluxel/build/rolldown': buildRolldown,
		'@pluxel/runtime-loader/register': runtimeLoaderRegister,
	},
	entry: {
		index: 'src/index.ts',
		register: 'src/register.ts',
		services: 'src/services.ts',
		dev: 'src/dev.ts',
		plugin: 'src/plugin.ts',
	},
	copy: ['src/dev/compile/bundler/bundle-worker.mjs'],
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions: {
		transform: {
			assumptions: {
				setPublicClassFields: true,
			},
			typescript: {
				removeClassFieldsWithoutInitializer: true,
			},
		},
	},
})
