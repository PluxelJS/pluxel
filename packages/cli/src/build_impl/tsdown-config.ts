import { defineConfig } from 'tsdown'

export const cliTsdownOverlay = defineConfig(() => ({
	exports: {
		// 特意区分开，不用 "@pluxel/source"，以避免本地链接直接用 ts 文件
		devExports: '@pluxel/hmr',
	},
	external: [/^@pluxel\//],
}))
