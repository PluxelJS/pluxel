import { defineConfig } from 'tsdown'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { hmrUiBridgePlugin } from '../rolldown/plugins/hmrUiBridgePlugin'
import { importTypeFixerPlugin } from '../rolldown/plugins/importTypeFixerPlugin'

export const cliTsdownOverlay = defineConfig(() => ({
	exports: {
		// 特意区分开，不用 "@pluxel/source"，以避免本地链接直接用 ts 文件
		devExports: '@pluxel/runtime',
	},
	external: [/^@pluxel\//],
	plugins: [importTypeFixerPlugin(), configSourcePlugin(), hmrUiBridgePlugin()],
}))
