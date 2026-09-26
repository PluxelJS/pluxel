import { resolve } from 'pathe'
import { defineConfig, mergeConfig } from 'vite'
import shellConfig from './shell/vite.config'

// Shell development and packaged assets share React, router and CSS configuration.
export default defineConfig((environment) =>
	mergeConfig(shellConfig(environment), {
		root: import.meta.dirname,
		appType: 'custom',
		publicDir: false,
		build: {
			outDir: 'public/',
			manifest: true,
			emptyOutDir: true,
			rolldownOptions: {
				input: resolve(import.meta.dirname, 'shell/src/client.tsx'),
			},
		},
	}),
)
