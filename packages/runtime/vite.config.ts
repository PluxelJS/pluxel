import { resolve } from 'pathe'
import { defineConfig } from 'vite'
import {
	buildPluxelFrontendResolveConditions,
	createPluxelUiChunkGroups,
	PLUXEL_UI_DEDUPE_PACKAGES,
} from '@pluxel/rolldown/workspace/vite'

export default defineConfig({
	appType: 'custom',
	publicDir: false,

	resolve: {
		conditions: buildPluxelFrontendResolveConditions(),
		dedupe: [...PLUXEL_UI_DEDUPE_PACKAGES],
	},

	build: {
		outDir: 'public/',
		manifest: true,
		emptyOutDir: true,
		rolldownOptions: {
			input: resolve(__dirname, '../workbench-app/src/client.tsx'),
			output: {
				codeSplitting: {
					groups: [
						{
							name: 'plugin-graph-vendor',
							test: /[\\/]node_modules[\\/](@xyflow|@dagrejs)[\\/]/,
							priority: 100,
							entriesAware: true,
						},
						...createPluxelUiChunkGroups(),
					],
				},
			},
		},
	},
})
