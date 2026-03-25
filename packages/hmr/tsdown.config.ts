import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		// Internal/private workspace packages must be bundled into the published artifact.
		alwaysBundle: ['@pluxel/build', '@pluxel/build/*', '@pluxel/workspace', '@pluxel/workspace/*'],
		onlyBundle: ['fdir'],
		neverBundle: ['@pluxel/core', '@pluxel/runtime', 'vite', 'vite/*'],
	},
	entry: {
		index: 'src/index.ts',
		host: 'src/host.ts',
		diagnose: 'src/diagnose.ts',
		plugin: 'src/plugin.ts',
		'plugin-build': 'src/plugin-build.ts',
		snapshot: 'src/snapshot.ts',
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
