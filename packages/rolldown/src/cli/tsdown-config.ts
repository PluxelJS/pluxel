import type { InlineConfig } from 'tsdown'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin } from '../rolldown/plugins/lintGuardPlugin'
import { workbenchUiBuildPlugin } from '../rolldown/plugins/workbenchUiBuildPlugin'
import { createPluginSourcePlugins, createPluginTransformOptions } from './plugin-source'
import type { BuildRuntimeConfig } from './types'

export const cliTsdownOverlay = (context: BuildRuntimeConfig): InlineConfig => ({
	exports: {
		// 特意区分开，不用 "@pluxel/source"，以避免本地链接直接用 ts 文件
		devExports: '@pluxel/runtime-dynamic',
	},
	deps: {
		neverBundle: [/^@pluxel\//],
	},
	plugins: [
		...createPluginSourcePlugins(context.projectRoot),
		lintGuardPlugin(),
		configSourcePlugin(),
		workbenchUiBuildPlugin({ root: context.projectRoot }),
	],
	inputOptions: {
		transform: createPluginTransformOptions(),
	},
})
