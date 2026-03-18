import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	noExternal: [
		// Internal/private workspace packages must be bundled into the published artifact.
		'@pluxel/build',
		'@pluxel/build/*',
		'@pluxel/workspace',
		'@pluxel/workspace/*',
	],
	entry: {
		index: 'src/index.ts',
		host: 'src/host.ts',
		diagnose: 'src/diagnose.ts',
		plugin: 'src/plugin.ts',
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
	external: ['@pluxel/core', '@pluxel/runtime', 'vite', 'vite/*'],
})
