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
			'@pluxel/commands',
			'@pluxel/commands/*',
			'@pluxel/core',
			'@pluxel/core/internal',
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
		vite: 'src/vite.ts',
		'internal/fetch-application': 'src/application/internal/fetch-application.ts',
		'internal/fetch-workbench-application':
			'src/application/internal/fetch-workbench-application.ts',
		'internal/node-application': 'src/application/internal/node-application.ts',
		'internal/node-workbench-application': 'src/application/internal/node-workbench-application.ts',
		environment: 'src/environment.ts',
		product: 'src/product.ts',
		test: 'src/test.ts',
		toolchain: 'src/toolchain.ts',
		internal: 'src/internal.ts',
		'internal/config-validation': 'src/internal-config-validation.ts',
		'internal/static': 'src/internal-static.ts',
		'internal/static-host': 'src/internal-static-host.ts',
		'internal/test': 'src/internal-test.ts',
		capnweb: 'src/capnweb.ts',
	},
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
