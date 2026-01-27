import { fileURLToPath } from 'node:url'
import { appendDtsImport } from '@pluxel/rolldown'
import { defineConfig } from 'tsdown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'

const valibotFormSrc = fileURLToPath(new URL('../valibot-form/src', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	plugins: [
		PreprocessorDirectives(),
		appendDtsImport('import type {} from "./services.d.mts"', ['index.d.mts']),
	],
	env: {},
	entry: {
		index: 'src/index.ts',
		logger: 'src/logger/index.ts',
		host: 'src/host/index.ts',
		services: 'src/services/index.ts',
		config: 'src/config.ts',
		web: 'src/web/web.ts',
		capnweb: 'src/web/capnweb.ts',
		signaldb: 'src/web/signaldb.ts',
	},
	copy: ['public', 'src/services/runtime-compile/bundler/bundle-worker.mjs'],
	alias: {
		'~': valibotFormSrc,
	},
	tsconfig: './tsconfig.json',
	dts: {
		resolver: 'oxc',
	},
	// 不要内联 core / react 相关，避免重复 vendor。
	external: [
		'@pluxel/core',
		'@pluxel/core/services',
		'@pluxel/core/logger',
		'@pluxel/context',
		'@pluxel/context/*',
		'@pluxel/components',
		'@pluxel/hmr-web',
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
			decorator: {
				legacy: true,
				emitDecoratorMetadata: true,
			},
		},
	},
})
