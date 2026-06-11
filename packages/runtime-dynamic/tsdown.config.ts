import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const rolldownPlugins = fileURLToPath(new URL('../rolldown/src/rolldown/index.ts', import.meta.url))
const runtimeDynamicRegister = fileURLToPath(new URL('./src/register.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/services',
			'@pluxel/runtime',
			'@pluxel/runtime/internal',
			'@pluxel/runtime/plugin-catalog',
			'@pluxel/runtime/shared',
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'@pluxel/rolldown/vite',
			'@pluxel/rolldown/vite/*',
			'vite',
			'vite/*',
		],
	},
	alias: {
		'@pluxel/rolldown/plugins': rolldownPlugins,
		'@pluxel/runtime-dynamic/register': runtimeDynamicRegister,
	},
	entry: {
		index: 'src/index.ts',
		register: 'src/register.ts',
		services: 'src/services.ts',
		hmr: 'src/hmr.ts',
	},
	copy: ['src/hmr/compile/bundler/bundle-worker.mjs'],
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
