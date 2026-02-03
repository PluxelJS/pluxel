import { rewriteDtsModuleAugmentations } from '@pluxel/build/rolldown'
import { defineConfig } from 'tsdown'

const moduleAugmentationMap = {
	'@pluxel/context': '@pluxel/core',
}

const createModuleRewritePlugin = () => rewriteDtsModuleAugmentations(moduleAugmentationMap)

const transformOptions = {
	assumptions: {
		setPublicClassFields: true,
	},
	typescript: {
		removeClassFieldsWithoutInitializer: true,
	},
}

export default defineConfig({
	inlineOnly: ['@abraham/reflection', /^option-t(\/.*)?$/],
	exports: {
		devExports: '@pluxel/source',
	},
	noExternal: ['@pluxel/context', '@pluxel/context/*'],
	external: [],
	entry: {
		env: 'src/env.ts',
		index: 'src/index.ts',
		services: 'src/services/index.ts',
		logger: 'src/logger/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	plugins: [createModuleRewritePlugin()],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions(options, _format, context) {
		options.transform = {
			...(options.transform ?? {}),
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
