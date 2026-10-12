import { defineConfig } from 'tsdown'
import { createPluginBuildPipeline } from '@pluxel/rolldown/build'

const pipeline = createPluginBuildPipeline({ root: import.meta.dirname, workbench: false })
export default defineConfig([
	{
		entry: {
			plugin: 'src/backend/plugin.ts',
			runtime: 'src/backend/runtime.ts',
			client: 'src/client/index.ts',
			contracts: 'src/shared/contracts.ts',
			'electron/main': 'src/electron/main.ts',
			'electron/backend': 'src/electron/backend.ts',
		},
		...pipeline,
		deps: { neverBundle: [/^@pluxel\//, /^@report-template-studio\//, 'electron', 'capnweb'] },
		format: 'esm',
		dts: { tsconfig: './tsconfig.build.json' },
		sourcemap: true,
		clean: true,
	},
	{
		entry: { preload: 'src/electron/preload.ts' },
		outDir: 'dist/electron',
		format: 'cjs',
		dts: false,
		clean: false,
		deps: { neverBundle: ['electron'] },
	},
])
