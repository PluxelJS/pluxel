import { resolve } from 'pathe'
import { defineConfig, mergeConfig } from 'vite'
import shellConfig from './shell/vite.config'
import { UI_PUBLIC_BASE } from './src/paths'

// Shell development and packaged assets share React, router and CSS configuration.
export default defineConfig((environment) =>
	mergeConfig(shellConfig(environment), {
		root: import.meta.dirname,
		appType: 'custom',
		base: `${UI_PUBLIC_BASE}/`,
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
