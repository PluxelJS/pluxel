import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const runtimeDynamicRegister = fileURLToPath(new URL('./src/register.ts', import.meta.url))
const runtimeDevEntry = fileURLToPath(new URL('../runtime-dev/src/index.ts', import.meta.url))
const runtimeDevExtensions = fileURLToPath(
	new URL('../runtime-dev/src/extensions.ts', import.meta.url),
)

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
		alwaysBundle: ['@pluxel/runtime-dev', '@pluxel/runtime-dev/*'],
	},
	alias: {
		'@pluxel/runtime-dynamic/register': runtimeDynamicRegister,
		'@pluxel/runtime-dev': runtimeDevEntry,
		'@pluxel/runtime-dev/extensions': runtimeDevExtensions,
	},
	entry: {
		index: 'src/index.ts',
		register: 'src/register.ts',
		services: 'src/services.ts',
		hmr: 'src/hmr.ts',
		plugin: 'src/plugin.ts',
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
