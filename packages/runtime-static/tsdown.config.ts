import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const runtimeDevEntry = fileURLToPath(new URL('../runtime-dev/src/index.ts', import.meta.url))
const runtimeDevViteEntry = fileURLToPath(new URL('../runtime-dev/src/vite.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'@pluxel/runtime/internal',
			'@pluxel/runtime/shared',
			'@pluxel/runtime/web/federation',
			'@pluxel/runtime/web/paths',
			'@oxc-resolver/binding-linux-x64-gnu',
			'oxc-parser',
			'oxc-resolver',
			'typescript',
			'vite',
			'vite/*',
		],
		alwaysBundle: ['@pluxel/runtime-dev', '@pluxel/runtime-dev/*'],
	},
	alias: {
		'@pluxel/runtime-dev': runtimeDevEntry,
		'@pluxel/runtime-dev/vite': runtimeDevViteEntry,
	},
	entry: {
		index: 'src/index.ts',
		vite: 'src/vite.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})
