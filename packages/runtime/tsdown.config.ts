import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'

const valibotFormSrc = fileURLToPath(new URL('../valibot-form/src', import.meta.url))
const workspaceIndex = fileURLToPath(new URL('../workspace/src/index.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		alwaysBundle: ['@pluxel/workspace', '@pluxel/workspace/*', 'valibot-form', 'valibot-form/*'],
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
		frozen: 'src/frozen.ts',
		// Type-only module augmentation bridge (stable .d.mts file for TS consumers).
		events: 'src/events.ts',
		logger: 'src/logger.ts',
		services: 'src/services.ts',
		shared: 'src/shared.ts',
		test: 'src/test.ts',
		vite: 'src/vite.ts',
		internal: 'src/internal.ts',
		config: 'src/config.ts',
		web: 'src/web.ts',
		'web/ui': 'src/web/ui.ts',
		'web/extensions': 'src/web/extensions.ts',
		'web/federation': 'src/web/federation.ts',
		'web/paths': 'src/web/paths.ts',
		capnweb: 'src/capnweb.ts',
	},
	copy: ['public'],
	alias: {
		'~': valibotFormSrc,
		'@pluxel/workspace': workspaceIndex,
	},
	tsconfig: './tsconfig.json',
	dts: {
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
