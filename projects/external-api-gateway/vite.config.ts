import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { prepareExternalGatewayRuntime } from './src/runtime-bootstrap'

export default defineConfig({
	appType: 'spa',
	server: {
		host: process.env.PLUXEL_HOST_BIND ?? '127.0.0.1',
		port: Number(process.env.PLUXEL_HOST_PORT ?? 3313),
	},
	plugins: [
		staticRuntimeVitePlugin({
			config: './src/pluxel.static.ts',
			prepareHost: (host) => prepareExternalGatewayRuntime(host.ctx),
		}),
		react(),
	],
})
