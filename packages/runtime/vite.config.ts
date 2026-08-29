import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
	WORKBENCH_SHELL_BUILD_INFO_FILE,
	WORKBENCH_SHELL_BUILD_INFO_VERSION,
} from '@pluxel/core/federation'
import { resolve } from 'pathe'
import { defineConfig, type Plugin } from 'vite'
import {
	buildPluxelFrontendResolveConditions,
	createPluxelUiChunkGroups,
	PLUXEL_UI_DEDUPE_PACKAGES,
} from '@pluxel/rolldown/workspace/vite'

const runtimePackage = JSON.parse(
	readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { pluxel?: { workbenchContractProtocol?: unknown } }
const workbenchContractProtocol = runtimePackage.pluxel?.workbenchContractProtocol
if (!Number.isInteger(workbenchContractProtocol) || Number(workbenchContractProtocol) <= 0) {
	throw new Error('packages/runtime/package.json must declare pluxel.workbenchContractProtocol')
}

export default defineConfig({
	appType: 'custom',
	publicDir: false,
	plugins: [workbenchShellBuildInfoPlugin()],

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

function workbenchShellBuildInfoPlugin(): Plugin {
	return {
		name: 'pluxel-workbench-shell-build-info',
		generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: WORKBENCH_SHELL_BUILD_INFO_FILE,
				source: `${JSON.stringify({
					version: WORKBENCH_SHELL_BUILD_INFO_VERSION,
					contractProtocol: workbenchContractProtocol,
				})}\n`,
			})
		},
	}
}
