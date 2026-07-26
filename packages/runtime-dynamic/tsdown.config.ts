import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const runtimeDevEntry = fileURLToPath(new URL('../runtime-dev/src/index.ts', import.meta.url))
const runtimeDevWorkbench = fileURLToPath(
	new URL('../runtime-dev/src/workbench.ts', import.meta.url),
)
const runtimeDevHmrLog = fileURLToPath(new URL('../runtime-dev/src/hmr-log.ts', import.meta.url))
const runtimeDevVite = fileURLToPath(new URL('../runtime-dev/src/vite.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/services',
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'@pluxel/runtime/internal',
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
		'@pluxel/runtime-dev': runtimeDevEntry,
		'@pluxel/runtime-dev/workbench': runtimeDevWorkbench,
		'@pluxel/runtime-dev/hmr-log': runtimeDevHmrLog,
		'@pluxel/runtime-dev/vite': runtimeDevVite,
	},
	plugins: [
		{
			name: 'pluxel:externalize-rolldown-vite-source-bridge',
			enforce: 'pre',
			resolveId: {
				filter: { id: /^\.\.\/\.\.\/rolldown\/src\/vite\/index\.ts$/ },
				handler() {
					return { id: '@pluxel/rolldown/vite', external: true }
				},
			},
		},
	],
	entry: {
		index: 'src/index.ts',
		services: 'src/services.ts',
		hmr: 'src/hmr.ts',
		'hmr/diagnose': 'src/hmr/diagnose.ts',
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
