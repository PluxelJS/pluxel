import { resolve } from 'pathe'
import { defineConfig, mergeConfig } from 'vite'
import shellConfig from './shell/vite.config'
import { UI_PUBLIC_BASE } from './src/paths'
import { resolveBuiltAssets } from './src/shell/assets'

// Shell development and packaged assets share React, router and CSS configuration.
export default defineConfig((environment) =>
	mergeConfig(shellConfig(environment), {
		root: import.meta.dirname,
		appType: 'custom',
		base: `${UI_PUBLIC_BASE}/`,
		publicDir: false,
		plugins: [
			{
				name: 'pluxel-workbench-shell-artifact',
				configResolved(config) {
					if (config.base !== `${UI_PUBLIC_BASE}/`)
						throw new Error(
							`Workbench Shell asset base must be ${UI_PUBLIC_BASE}/, got ${config.base}`,
						)
				},
				async writeBundle() {
					await resolveBuiltAssets(resolve(import.meta.dirname, 'public'))
				},
			},
		],
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
