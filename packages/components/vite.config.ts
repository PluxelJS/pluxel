// vite.config.ts

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function fixRolldownUndefinedExports() {
	return {
		name: 'fix-rolldown-undefined-exports',
		enforce: 'post',
		generateBundle(_options, bundle) {
			// Workaround for a Vite 8 / Rolldown output bug where a chunk can re-export an
			// identifier that was never declared (e.g. `server_browser_exports`), causing:
			// `Uncaught SyntaxError: Export '...' is not defined in module`.
			for (let entry of Object.values(bundle)) {
				if (entry.type !== 'chunk') continue
				if (!entry.code.includes('server_browser_exports')) continue
				if (/\b(?:var|let|const)\s+server_browser_exports\b/.test(entry.code)) continue
				entry.code = `var server_browser_exports;\n${entry.code}`
			}
		},
	}
}

export default defineConfig(({ mode }) => {
	const isDev = mode !== 'production'

	return {
		server: {
			proxy: {
				// API + GraphQL 走后端 3000，方便本地联调
				'/api': {
					target: 'http://localhost:3000',
					changeOrigin: true,
				},
				'/graphql': {
					target: 'http://localhost:3000',
					changeOrigin: true,
				},
			},
		},
		resolve: {
			tsconfigPaths: true,
			dedupe: [
				'react',
				'react-dom',
				'@mantine/core',
				'@mantine/hooks',
				'@mantine/notifications',
				'@mantine/dates',
			],
			alias: {
				// 你的设置：避免为每个图标单独切 chunk
				'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
			},
		},

		plugins: [react(), fixRolldownUndefinedExports()],

		// 关键：把 Mantine/Emotion 相关预打包，减少 cold start + 提升 HMR 稳定
		optimizeDeps: {
			include: [
				'react',
				'react-dom',
				'@mantine/core',
				'@mantine/hooks',
				'@mantine/notifications',
				// 你若用到再加：'@mantine/dates', 'dayjs'
				'@tabler/icons-react',
			],
		},

		// 更合理的生产分包：react/mantine/emotion/tabler 独立缓存
		build: {
			sourcemap: isDev ? true : 'hidden',
			rollupOptions: {
				output: {
					advancedChunks: {
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
	}
})
