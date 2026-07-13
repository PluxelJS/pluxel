import type { InlineConfig } from 'tsdown'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin } from '../rolldown/plugins/lintGuardPlugin'
import { managementUiBuildPlugin } from '../rolldown/plugins/managementUiBuildPlugin'
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
		lintGuardPlugin(),
		configSourcePlugin(),
		managementUiBuildPlugin({ root: context.projectRoot }),
	],
})
