import { fileURLToPath } from 'node:url'
// Vite loads its config before workspace source conditions are active.
import { staticRuntimeVitePlugin } from '../../packages/runtime-static/src/vite.ts'
import { createPluxelUiChunkGroups } from '@pluxel/rolldown/workspace/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	resolve: {
		alias: {
			// The workspace package exports generated CSS, while source-mode Vite
			// consumes its checked-in stylesheet directly.
			'@worksplit/react/style.css': fileURLToPath(
				new URL('../../vendor/split-like-vscode/packages/react/src/style.css', import.meta.url),
			),
		},
	},
	server: {
		host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
		port: Number(process.env.PLUXEL_HOST_PORT ?? 3314),
	},
	build: {
		chunkSizeWarningLimit: 700,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [...createPluxelUiChunkGroups()],
				},
			},
		},
	},
	plugins: [
		staticRuntimeVitePlugin({
			config: './src/pluxel.static.ts',
			// @module-federation/vite currently shares build-global virtual state.
			// Serialize the two adapter remotes to keep their generated entries isolated.
			hmr: { extensionCompiler: { compileConcurrency: 1 } },
		}),
		react(),
	],
})
