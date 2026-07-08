import { fileURLToPath } from 'node:url'
import { gqlens } from '@gqlens/vite'
// Vite loads this config before Pluxel source conditions are active, so use the
// workspace source here to avoid running stale runtime-static dist output.
import { staticRuntimeVitePlugin } from '../../runtime-static/src/vite.ts'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { commercialGraphQLEndpoint } from './src/paths.ts'
const graphQLPackageRoot = fileURLToPath(new URL('node_modules/graphql', import.meta.url))

export default defineConfig({
	appType: 'spa',
	plugins: [
		staticRuntimeVitePlugin({
			config: './src/pluxel.static.ts',
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
})
