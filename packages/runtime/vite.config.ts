// vite.config.ts
import { fileURLToPath } from 'node:url'
import { resolve } from 'pathe'
import { defineConfig } from 'vite'
import {
	buildPluxelFrontendResolveConditions,
	createPluxelUiChunkGroups,
	PLUXEL_UI_DEDUPE_PACKAGES,
	PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE,
} from '../workspace/src/vite'
import { createRuntimeWebPlugins } from './vite/plugins'

const runtimeAliases = [
	{
		find: /^@pluxel\/runtime$/,
		replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/web$/,
		replacement: fileURLToPath(new URL('./src/web.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/web\/ui$/,
		replacement: fileURLToPath(new URL('./src/web/ui.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/web\/extensions$/,
		replacement: fileURLToPath(new URL('./src/web/extensions.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/web\/federation$/,
		replacement: fileURLToPath(new URL('./src/web/federation.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/capnweb$/,
		replacement: fileURLToPath(new URL('./src/capnweb.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/config$/,
		replacement: fileURLToPath(new URL('./src/config.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/logger$/,
		replacement: fileURLToPath(new URL('./src/logger.ts', import.meta.url)),
	},
	{
		find: /^@pluxel\/runtime\/services$/,
		replacement: fileURLToPath(new URL('./src/services.ts', import.meta.url)),
	},
]

export default defineConfig({
	appType: 'custom',
	// 输出目录与 public 相同，为了避免 Vite 拷贝 public -> public 产生警告，直接关闭 publicDir
	publicDir: false,
	plugins: createRuntimeWebPlugins(),
	ssr: {
		external: ['react', 'react-dom'],
		resolve: {
			conditions: buildPluxelFrontendResolveConditions(),
		},
	},

	resolve: {
		conditions: buildPluxelFrontendResolveConditions(),
		alias: runtimeAliases,
		// 避免多份实例导致上下文不一致（Mantine/React）
		dedupe: [...PLUXEL_UI_DEDUPE_PACKAGES],
	},

	optimizeDeps: {
		// 关键2：预构建阶段就别再动它，避免二次语义压缩
		exclude: ['immutable'],
		include: [...PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE],
	},

	build: {
		outDir: 'public/',
		manifest: true,
		emptyOutDir: true,
		rolldownOptions: {
			input: resolve(__dirname, 'src/client.tsx'),
			treeshake: {
				// 关键4：对 immutable 保留副作用标记，避免把内部 runtime 标记摇没
				moduleSideEffects: (id) => (/immutable/.test(id) ? true : undefined),
			},
			output: {
				// 更合理的生产分包：react/mantine/emotion/tabler 独立缓存
				codeSplitting: {
					groups: createPluxelUiChunkGroups(),
				},
			},
		},
	},
})
