import { resolve } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { pluginModules } from '@pluxel/host-vite/modules'
import { defineConfig } from 'vite'

const root = import.meta.dirname
export default defineConfig({
	root: resolve(root, 'web'),
	publicDir: false,
	environments: {
		client: {
			resolve: { conditions: ['@pluxel/hmr', 'module', 'browser', 'development|production'] },
		},
	},
	oxc: { decorator: { legacy: true } },
	plugins: [
		cloudflare({
			persistState: { path: resolve(root, '.wrangler/state') },
			configPath: resolve(root, 'wrangler.jsonc'),
			config: { main: resolve(root, 'src/worker.ts') },
			viteEnvironment: { name: 'cloudflare' },
		}),
		pluginModules({ root, environments: ['cloudflare'] }),
	],
})
