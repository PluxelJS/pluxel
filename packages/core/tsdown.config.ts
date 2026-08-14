import { defineConfig } from 'tsdown'
import Macros from 'unplugin-macros/rolldown'
import { rewriteCoreDtsModuleAugmentations } from './tools/rewriteDtsModuleAugmentations.ts'

const createModuleRewritePlugin = () => rewriteCoreDtsModuleAugmentations()

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
		onlyBundle: ['@abraham/reflection', /^option-t(\/.*)?$/],
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
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	plugins: [Macros(), createModuleRewritePlugin()],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions(options, _format, context) {
		options.transform = {
			...options.transform,
			...transformOptions,
		}

		if (!context.cjsDts) return

		const basePlugins = options.plugins
			? Array.isArray(options.plugins)
				? options.plugins
				: [options.plugins]
			: []

		options.plugins = [...basePlugins, createModuleRewritePlugin()]
		return options
	},
})
