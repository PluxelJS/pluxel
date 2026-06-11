import { defineConfig } from 'tsdown'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { runtimeUiBridgePlugin } from '../rolldown/plugins/runtimeUiBridgePlugin'
import { lintGuardPlugin } from '../rolldown/plugins/lintGuardPlugin'

export const cliTsdownOverlay = defineConfig(() => ({
	exports: {
		// 特意区分开，不用 "@pluxel/source"，以避免本地链接直接用 ts 文件
		devExports: '@pluxel/runtime-dynamic',
	},
	deps: {
		neverBundle: [/^@pluxel\//],
	},
	plugins: [lintGuardPlugin(), configSourcePlugin(), runtimeUiBridgePlugin()],
}))
