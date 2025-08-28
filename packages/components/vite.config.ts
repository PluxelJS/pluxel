// vite.config.ts

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig(({ mode }) => {
	const isDev = mode !== 'production'

	return {
		resolve: {
			alias: {
				// 你的设置：避免为每个图标单独切 chunk
				'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
			},
		},

		plugins: [react(), tsconfigPaths()],

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
					manualChunks(id) {
						if (id.includes('node_modules')) {
							if (id.includes('/react/')) return 'react'
							if (id.includes('@mantine/')) return 'mantine'
							if (id.includes('@emotion/')) return 'emotion'
							if (id.includes('@tabler/icons-react')) return 'tabler'
							return 'vendor'
						}
					},
				},
			},
		},
	}
})
