// vite.config.ts
import { fileURLToPath } from 'node:url'
import { resolve } from 'pathe'
import { defineConfig } from 'vite'

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

function fixRolldownUndefinedExports() {
	return {
		name: 'fix-rolldown-undefined-exports',
		enforce: 'post',
		generateBundle(_options, bundle) {
			// Workaround for a Vite 8 / Rolldown output bug where a chunk can re-export an
			// identifier that was never declared (e.g. `server_browser_exports`), causing:
			// `Uncaught SyntaxError: Export '...' is not defined in module`.
			for (const entry of Object.values(bundle)) {
				if (entry.type !== 'chunk') continue
				if (!entry.code.includes('server_browser_exports')) continue
				if (/\b(?:var|let|const)\s+server_browser_exports\b/.test(entry.code)) continue
				entry.code = `var server_browser_exports;\n${entry.code}`
			}
		},
	}
}

export default defineConfig({
	appType: 'custom',
	// 输出目录与 public 相同，为了避免 Vite 拷贝 public -> public 产生警告，直接关闭 publicDir
	publicDir: false,
	plugins: [fixRolldownUndefinedExports()],
	ssr: {
		external: ['react', 'react-dom'],
	},

	resolve: {
		alias: runtimeAliases,
		// 避免多份实例导致上下文不一致（Mantine/React）
		dedupe: [
			'react',
			'react-dom',
			'@mantine/core',
			'@mantine/hooks',
			'@mantine/notifications',
			'@mantine/dates',
		],
	},

	optimizeDeps: {
		// 关键2：预构建阶段就别再动它，避免二次语义压缩
		exclude: ['immutable'],
		include: [
			'react',
			'react-dom',
			'@mantine/core',
			'@mantine/hooks',
			'@mantine/notifications',
			'@tabler/icons-react',
		],
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
					groups: [
						{
							name: 'react',
							test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/,
							priority: 50,
						},
						{
							name: 'mantine',
							test: /[\\/]node_modules[\\/]@mantine[\\/]/,
							priority: 40,
						},
						{
							name: 'emotion',
							test: /[\\/]node_modules[\\/]@emotion[\\/]/,
							priority: 30,
						},
						{
							name: 'tanstack',
							test: /[\\/]node_modules[\\/]@tanstack[\\/]/,
							priority: 28,
						},
						{
							name: 'gqty',
							test: /[\\/]node_modules[\\/](gqty|graphql)[\\/]/,
							priority: 26,
						},
						{
							name: 'mf-runtime',
							test: /[\\/]node_modules[\\/]@module-federation[\\/]/,
							priority: 24,
						},
						{
							name: 'dnd-kit',
							test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/,
							priority: 22,
						},
						{
							name: 'tabler',
							test: /[\\/]node_modules[\\/]@tabler[\\/]icons-react[\\/]/,
							priority: 20,
						},
						{
							name: 'vendor',
							test: /[\\/]node_modules[\\/]/,
							priority: 0,
							minSize: 10 * 1024,
						},
					],
				},
			},
		},
	},
})
