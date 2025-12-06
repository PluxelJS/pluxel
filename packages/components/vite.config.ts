// vite.config.ts

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

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
            dedupe: ['react', 'react-dom', '@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/dates'],
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
				'obug',
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
