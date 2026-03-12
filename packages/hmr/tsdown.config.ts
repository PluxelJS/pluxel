import { fileURLToPath } from 'node:url'
import { appendDtsImport, rewriteDtsText } from '@pluxel/build/rolldown'
import { defineConfig } from 'tsdown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'

const valibotFormSrc = fileURLToPath(new URL('../valibot-form/src', import.meta.url))
const buildRoot = fileURLToPath(new URL('../build/src', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))
const workspaceIndex = fileURLToPath(new URL('../workspace/src/index.ts', import.meta.url))
const dtsRewriteMap = {
	'@pluxel/hmr-web/react': '@pluxel/hmr/web',
	'@pluxel/hmr-web/vendors': '@pluxel/hmr/web',
	'@pluxel/hmr-web': '@pluxel/hmr/web',
} as const

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	noExternal: [
		'@pluxel/build',
		'@pluxel/build/*',
		'@pluxel/workspace',
		'@pluxel/workspace/*',
		'valibot-form',
		'valibot-form/*',
	],
	plugins: [
		PreprocessorDirectives(),
		appendDtsImport('import type {} from "./events.d.mts"', ['index.d.mts']),
		appendDtsImport('import type {} from "./services.d.mts"', ['index.d.mts']),
		rewriteDtsText(dtsRewriteMap, { assertNotContains: ['@pluxel/hmr-web'] }),
	],
	env: {},
	entry: {
		index: 'src/index.ts',
		// Type-only module augmentation bridge (stable .d.mts file for TS consumers).
		events: 'src/events.ts',
		logger: 'src/logger/index.ts',
		host: 'src/host/index.ts',
		services: 'src/services/index.ts',
		config: 'src/config.ts',
		snapshot: 'src/snapshot.ts',
		diagnose: 'src/diagnose/index.ts',
		web: 'src/web/web.ts',
		capnweb: 'src/web/capnweb.ts',
		signaldb: 'src/web/signaldb.ts',
	},
	copy: ['public', 'src/services/runtime-compile/bundler/bundle-worker.mjs'],
	alias: {
		'~': valibotFormSrc,
		'@pluxel/build': buildRoot,
		'@pluxel/build/rolldown': buildRolldown,
		'@pluxel/workspace': workspaceIndex,
	},
	tsconfig: './tsconfig.json',
	dts: {
		resolver: 'oxc',
		eager: true,
	},
	// 不要内联 core / react 相关，避免重复 vendor。
	external: [
		'@pluxel/core',
		'@pluxel/core/services',
		'@pluxel/core/logger',
		'@pluxel/components',
		'react',
		'react/jsx-runtime',
		'react-dom',
	],
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
