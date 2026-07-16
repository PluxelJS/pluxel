import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'

const valibotFormSrc = fileURLToPath(new URL('../valibot-form/src', import.meta.url))
const rolldownWorkspaceFs = fileURLToPath(
	new URL('../rolldown/src/workspace/fs-entry.ts', import.meta.url),
)
const rolldownWorkspaceInfo = fileURLToPath(
	new URL('../rolldown/src/workspace/info-entry.ts', import.meta.url),
)
const inlineWorkspaceHelpers = ['@pluxel/rolldown/workspace/fs', '@pluxel/rolldown/workspace/info']

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		alwaysBundle: [...inlineWorkspaceHelpers, 'valibot-form', 'valibot-form/*'],
		onlyBundle: [],
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/services',
			'@pluxel/core/logger',
			'react',
			'react/jsx-runtime',
			'react-dom',
			'vite',
		],
	},
	plugins: [PreprocessorDirectives()],
	env: {},
	entry: {
		index: 'src/index.ts',
		// Type-only module augmentation bridge (stable .d.mts file for TS consumers).
		events: 'src/events.ts',
		logger: 'src/logger.ts',
		'services/vault': 'src/services/vault.ts',
		test: 'src/test.ts',
		toolchain: 'src/toolchain.ts',
		internal: 'src/internal.ts',
		'internal/static': 'src/internal-static.ts',
		'internal/static-host': 'src/internal-static-host.ts',
		web: 'src/web.ts',
		workbench: 'src/workbench.ts',
		'workbench/contract': 'src/workbench-contract.ts',
		'workbench/ui': 'src/workbench-ui.ts',
		'workbench/ui/internal': 'src/workbench-ui-internal.ts',
		'web/paths': 'src/web/paths.ts',
		capnweb: 'src/capnweb.ts',
	},
	copy: ['public'],
	alias: {
		'valibot-form': `${valibotFormSrc}/index.ts`,
		'~': valibotFormSrc,
		'@pluxel/rolldown/workspace/fs': rolldownWorkspaceFs,
		'@pluxel/rolldown/workspace/info': rolldownWorkspaceInfo,
	},
	tsconfig: './tsconfig.json',
	dts: {
		eager: true,
		sourcemap: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions: {
		transform: {
			assumptions: {
				setPublicClassFields: true,
			},
			typescript: {
				removeClassFieldsWithoutInitializer: true,
			},
		},
	},
})
