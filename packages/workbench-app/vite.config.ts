import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import {
	buildPluxelFrontendResolveConditions,
	createPluxelUiChunkGroups,
	PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER,
	PLUXEL_UI_DEDUPE_PACKAGES,
	PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE,
} from '@pluxel/rolldown/workspace/vite'
import { gqlens } from '@gqlens/vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

const MANTINE_SASS_ENTRY = fileURLToPath(
	new URL('./src/styles/theme/_mantine.scss', import.meta.url),
).replaceAll('\\', '/')

export default defineConfig(({ mode }) => {
	const isDev = mode !== 'production'
	const resolveConditions = buildPluxelFrontendResolveConditions(mode)

	return {
		server: {
			proxy: {
				// Pluxel runtime internal API 走后端 3000，方便本地联调
				'/__pluxel/runtime': {
					target: 'http://localhost:3000',
					changeOrigin: true,
				},
			},
		},
		resolve: {
			conditions: resolveConditions,
			dedupe: [...PLUXEL_UI_DEDUPE_PACKAGES],
			alias: {
				// Avoid splitting each icon into a separate chunk.
				'@tabler/icons-react': PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER,
			},
		},

		plugins: [
			gqlens({
				output: 'src/app/gqlens',
				entry: '/src/app/gqlens/graphql-entry.ts',
				endpoint: '/graphql',
				include: [
					/packages\/runtime\/src\/api\//,
					/packages\/runtime\/src\/services\/http\/internalGraphqlSchema\.ts$/,
					/packages\/runtime-dynamic\/src\/api\//,
					/packages\/workbench-app\/src\/app\/gqlens\/graphql-entry\.ts$/,
				],
				framework: 'react',
				middleware: false,
			}),
			tanstackRouter({
				target: 'react',
				autoCodeSplitting: true,
				routesDirectory: './src/app/router/routes',
				generatedRouteTree: './src/app/router/routeTree.gen.ts',
			}),
			react(),
		],

		css: {
			preprocessorOptions: {
				scss: {
					api: 'modern-compiler',
					additionalData: `@use "${MANTINE_SASS_ENTRY}" as mantine;`,
				},
			},
		},

		optimizeDeps: {
			include: [...PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE],
		},

		build: {
			sourcemap: isDev ? true : 'hidden',
			rolldownOptions: {
				output: {
					codeSplitting: {
						groups: createPluxelUiChunkGroups(),
					},
				},
			},
		},
	}
})
