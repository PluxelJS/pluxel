import { defineConfig } from 'tsdown'
import Macros from 'unplugin-macros/rolldown'

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
		onlyBundle: ['option-t'],
		alwaysBundle: ['@pluxel/context', '@pluxel/context/*'],
	},
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		federation: 'src/federation.ts',
		internal: 'src/internal.ts',
		index: 'src/index.ts',
		services: 'src/services/index.ts',
		logger: 'src/logger/index.ts',
		test: 'src/test.ts',
		toolchain: 'src/toolchain.ts',
	},
	dts: {
		// Context declarations are bundled from workspace source outside Core's tsconfig root.
		eager: true,
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	plugins: [Macros()],
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
