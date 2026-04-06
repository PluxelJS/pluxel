import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import {
	buildPluxelFrontendResolveConditions,
	createPluxelUiChunkGroups,
	PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER,
	PLUXEL_UI_DEDUPE_PACKAGES,
	PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE,
} from '../workspace/src/vite'
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

	return {
		server: {
			proxy: {
				// Pluxel HMR internal API 走后端 3000，方便本地联调
				'/__pluxel/hmr': {
					target: 'http://localhost:3000',
					changeOrigin: true,
				},
			},
		},
		resolve: {
			conditions: resolveConditions,
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
				conditions: resolveConditions,
			},
		},

		plugins: createWorkbenchFrontendPlugins(),

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
