import { fileURLToPath } from 'node:url'
import { gqlens } from '@gqlens/vite'
import {
	staticRuntimeHostVitePlugin,
	staticRuntimeSourceVitePlugin,
	staticRuntimeUiBridgeVitePlugin,
} from '@pluxel/runtime-static/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { commercialGraphQLEndpoint } from './src/paths.ts'
const graphQLPackageRoot = fileURLToPath(new URL('node_modules/graphql', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export default defineConfig(({ command }) => ({
	appType: 'spa',
	plugins: [
		staticRuntimeSourceVitePlugin({ root: repoRoot }),
		...(command === 'serve' ? [] : [staticRuntimeUiBridgeVitePlugin()]),
		staticRuntimeHostVitePlugin({
			name: 'pluxel-static-commercial-host',
			async createHost() {
				const staticHostModuleUrl = new URL('./src/static-host.ts', import.meta.url).href
				const { createStaticCommercialRuntimeHost } = (await import(
					/* @vite-ignore */ staticHostModuleUrl
				)) as typeof import('./src/static-host')
				return createStaticCommercialRuntimeHost()
			},
		}),
		gqlens({
			output: 'web/gqlens',
			entry: '/src/graphql-entry.ts',
			endpoint: commercialGraphQLEndpoint,
			include: [/\/src\//],
			framework: 'react',
			middleware: false,
		}),
		react(),
	],
	resolve: {
		alias: [
			{ find: /^graphql$/, replacement: `${graphQLPackageRoot}/index.mjs` },
			{ find: /^graphql\/(.+)$/, replacement: `${graphQLPackageRoot}/$1` },
		],
	},
	optimizeDeps: {
		exclude: ['graphql', 'graphql-yoga'],
	},
}))
