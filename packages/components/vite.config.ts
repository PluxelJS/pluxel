import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import {
	buildPluxelFrontendResolveConditions,
	createPluxelUiChunkGroups,
	PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER,
	PLUXEL_UI_DEDUPE_PACKAGES,
	PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE,
} from '@pluxel/rolldown/workspace/vite'
// Vite externalizes config dependencies before project resolve.conditions apply.
// Use the GQLens workspace source here; app/runtime imports still use package conditions.
import { gqlens } from '@gqlens/vite'
import { createWorkbenchFrontendPlugins } from './vite/plugins'

const VALIBOT_FORM_SOURCE_ENTRY = fileURLToPath(
	new URL('../valibot-form/src/index.ts', import.meta.url),
)
const VALIBOT_FORM_WEB_SOURCE_ENTRY = fileURLToPath(
	new URL('../valibot-form/src/web/index.ts', import.meta.url),
)
const MANTINE_SASS_ENTRY = fileURLToPath(
	new URL('./src/styles/theme/_mantine.scss', import.meta.url),
).replaceAll('\\', '/')

export default defineConfig(({ mode }) => {
	const isDev = mode !== 'production'
	const resolveConditions = buildPluxelFrontendResolveConditions(mode)
	const developmentResolveConditions = ['development', ...resolveConditions]

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
			conditions: developmentResolveConditions,
			dedupe: [...PLUXEL_UI_DEDUPE_PACKAGES],
			alias: {
				// Workspace frontend should always consume current source, not stale package dist output.
				'valibot-form/web': VALIBOT_FORM_WEB_SOURCE_ENTRY,
				'valibot-form': VALIBOT_FORM_SOURCE_ENTRY,
				// Avoid splitting each icon into a separate chunk.
				'@tabler/icons-react': PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER,
			},
		},
		ssr: {
			resolve: {
				conditions: developmentResolveConditions,
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
					/packages\/components\/src\/app\/gqlens\/graphql-entry\.ts$/,
				],
				framework: 'react',
				middleware: false,
			}),
			...createWorkbenchFrontendPlugins(),
		],

		css: {
			preprocessorOptions: {
				scss: {
					api: 'modern-compiler',
					additionalData: `@use "${MANTINE_SASS_ENTRY}" as mantine;`,
				},
			},
		},

		// Pre-bundle common deps for faster cold start and more stable HMR.
		optimizeDeps: {
			include: [...PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE],
		},

		// Production chunking: keep common libraries cache-friendly.
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
