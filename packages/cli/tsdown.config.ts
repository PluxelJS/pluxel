import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const buildRoot = fileURLToPath(new URL('../build/src', import.meta.url))
const buildCli = fileURLToPath(new URL('../build/src/cli/index.ts', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))
const workspaceIndex = fileURLToPath(new URL('../workspace/src/index.ts', import.meta.url))
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
	// `inlineOnly` would require us to enumerate (and maintain) the entire transitive dependency
	// set pulled in by bundled deps (e.g. Ink), so we suppress the warning.
	inlineOnly: false,
	// Inline internal build helpers + CLI-only deps so published CLI stays light on runtime deps.
	noExternal: [
		'@pluxel/build',
		'@pluxel/build/*',
		'@pluxel/workspace',
		'@pluxel/workspace/*',
		'react',
		'react/*',
		'ink',
		'ink/*',
	],
	alias: {
		'@pluxel/build': buildRoot,
		'@pluxel/build/cli': buildCli,
		'@pluxel/build/rolldown': buildRolldown,
		'@pluxel/workspace': workspaceIndex,
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
