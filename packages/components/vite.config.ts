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
			for (const entry of Object.values(bundle)) {
				if (entry.type !== 'chunk') continue
				if (!entry.code.includes('server_browser_exports')) continue
				if (/\b(?:var|let|const)\s+server_browser_exports\b/.test(entry.code)) continue
				entry.code = `var server_browser_exports;\n${entry.code}`
			}
		},
	}
}

// biome-ignore lint/style/noDefaultExport: Vite config expects a default export.
export default defineConfig(({ mode }) => {
	const isDev = mode !== 'production'

	return {
		server: {
			proxy: {
				// Pluxel HMR internal API 走后端 3000，方便本地联调
				'/__pluxel/hmr': {
					target: 'http://localhost:3000',
					changeOrigin: true,
				},
			},
		},
		resolve: {
			dedupe: [
				'react',
				'react-dom',
				'@mantine/core',
				'@mantine/hooks',
				'@mantine/notifications',
				'@mantine/dates',
			],
			alias: {
				// Avoid splitting each icon into a separate chunk.
				'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
			},
		},

		plugins: [react(), fixRolldownUndefinedExports()],

		// Pre-bundle common deps for faster cold start and more stable HMR.
		optimizeDeps: {
			include: [
				'react',
				'react-dom',
				'@mantine/core',
				'@mantine/hooks',
				'@mantine/notifications',
				// Add when needed: '@mantine/dates', 'dayjs'
				'@tabler/icons-react',
			],
		},

		// Production chunking: keep common libraries cache-friendly.
		build: {
			sourcemap: isDev ? true : 'hidden',
			rollupOptions: {
				output: {
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
