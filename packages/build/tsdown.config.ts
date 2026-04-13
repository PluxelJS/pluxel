import { defineConfig } from 'tsdown'

export default defineConfig({
	deps: {
		// Keep rolldown itself external in the public surface; helper deps can still be bundled if tsdown decides to.
		neverBundle: ['rolldown', 'rolldown/*'],
	},
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: 'src/index.ts',
		cli: 'src/cli/index.ts',
		rolldown: 'src/rolldown/index.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm', 'cjs'],
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
