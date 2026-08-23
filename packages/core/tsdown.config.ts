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
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	plugins: [Macros()],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions(options) {
		options.transform = {
			...options.transform,
			...transformOptions,
		}
	},
})
