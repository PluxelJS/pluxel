import { defineConfig } from 'tsdown'

const fastBuild = process.env.PLUXEL_FAST_BUILD === 'true'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		alwaysBundle: ['@rolldown/pluginutils', 'fdir', 'pathe'],
		neverBundle: [
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'rolldown',
			'rolldown/*',
			'vite',
			'vite/*',
		],
	},
	entry: {
		index: 'src/index.ts',
		build: 'src/cli/index.ts',
		plugins: 'src/rolldown/index.ts',
		'resolver/oxc': 'src/resolver/oxc.ts',
		vite: 'src/vite/index.ts',
		'vite/environment': 'src/vite/environment.ts',
		'vite/paraglide': 'src/vite/paraglide.ts',
		'vite/plugin-ui': 'src/vite/plugin-ui.ts',
		workspace: 'src/workspace/index.ts',
		'workspace/fs': 'src/workspace/fs-entry.ts',
		'workspace/info': 'src/workspace/info-entry.ts',
		'workspace/vite': 'src/workspace/vite.ts',
		oxlint: 'src/workspace/oxlint/index.ts',
	},
	dts: {
		sourcemap: !fastBuild,
		eager: true,
	},
	env: {
		BUILD: 'true',
		DEV: 'false',
		NODE_ENV: 'production',
	},
	format: ['esm'],
	sourcemap: !fastBuild,
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
