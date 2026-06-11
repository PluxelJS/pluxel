import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const rolldownBuild = fileURLToPath(new URL('../rolldown/src/cli/index.ts', import.meta.url))
const rolldownPlugins = fileURLToPath(new URL('../rolldown/src/rolldown/index.ts', import.meta.url))
const rolldownWorkspaceFs = fileURLToPath(
	new URL('../rolldown/src/workspace/fs-entry.ts', import.meta.url),
)
const rolldownWorkspaceInfo = fileURLToPath(
	new URL('../rolldown/src/workspace/info-entry.ts', import.meta.url),
)
const reactDevtoolsCoreStub = fileURLToPath(
	new URL('./src/vendor/react-devtools-core.ts', import.meta.url),
)

const fastBuild = process.env.PLUXEL_FAST_BUILD === 'true'

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		build: './src/build.ts',
		rolldown: './src/rolldown.ts',
		hmr: './src/hmr/index.ts',
	},
	// This CLI intentionally ships as a bundled artifact with minimal runtime deps.
	// Bundle internal toolchain pieces and CLI-only UI deps so the published CLI keeps a small runtime surface.
	deps: {
		// `@pluxel/rolldown` exports rolldown plugin types. Keep rolldown itself external instead of re-bundling it here.
		neverBundle: ['rolldown', 'rolldown/*'],
		alwaysBundle: [
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'react',
			'react/*',
			'ink',
			'ink/*',
		],
	},
	alias: {
		'@pluxel/rolldown/build': rolldownBuild,
		'@pluxel/rolldown/plugins': rolldownPlugins,
		'@pluxel/rolldown/workspace/fs': rolldownWorkspaceFs,
		'@pluxel/rolldown/workspace/info': rolldownWorkspaceInfo,
		'react-devtools-core': reactDevtoolsCoreStub,
	},
	dts: {
		sourcemap: !fastBuild,
		eager: true,
	},
	env: {
		BUILD: 'true',
		DEV: 'false',
		NODE_ENV: 'production',
	},
	copy: ['templates'],
	plugins: [],
	format: ['esm'],
	clean: true,
	sourcemap: !fastBuild,
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
