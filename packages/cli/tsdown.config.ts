import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const reactDevtoolsCoreStub = fileURLToPath(
	new URL('./src/vendor/react-devtools-core.ts', import.meta.url),
)

const fastBuild = process.env.PLUXEL_FAST_BUILD === 'true'
const inlineRuntimeDeps = [
	'@alcalzone/ansi-tokenize',
	'ansi-escapes',
	'ansi-regex',
	'ansi-styles',
	'auto-bind',
	'chalk',
	'cli-boxes',
	'cli-cursor',
	'cli-truncate',
	'code-excerpt',
	'convert-to-spaces',
	'emoji-regex',
	'environment',
	'es-toolkit',
	'escape-string-regexp',
	'get-east-asian-width',
	'indent-string',
	'ink',
	'is-fullwidth-code-point',
	'is-in-ci',
	'mimic-fn',
	'onetime',
	'patch-console',
	'react',
	'react-reconciler',
	'restore-cursor',
	'scheduler',
	'signal-exit',
	'slice-ansi',
	'stack-utils',
	'string-width',
	'strip-ansi',
	'terminal-size',
	'widest-line',
	'wrap-ansi',
	'ws',
	'yoga-layout',
]

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
	},
	// This CLI intentionally ships as a mostly bundled artifact, but consumes
	// @pluxel/rolldown as a published toolchain package instead of vendoring it.
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/*',
			'@pluxel/market',
			'@pluxel/market/*',
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'@pluxel/runtime-dynamic',
			'@pluxel/runtime-dynamic/*',
			'rolldown',
			'rolldown/*',
		],
		// The CLI intentionally bundles its app/UI stack; the toolchain package stays external above.
		alwaysBundle: inlineRuntimeDeps,
		onlyBundle: inlineRuntimeDeps,
	},
	alias: {
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
	copy: ['templates', '../../user-docs'],
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
