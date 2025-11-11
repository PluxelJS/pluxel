import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'

const valibotFormSrc = fileURLToPath(new URL('../valibot-form/src', import.meta.url))

function appendDtsImport(snippet: string, file = 'index.d.ts') {
	const exts = /\.d\.(?:mts|cts|ts)$/i
	return {
		name: 'append-dts-import',
		generateBundle(_, bundle) {
			for (const [name, chunk] of Object.entries(bundle)) {
				if (!exts.test(name)) continue
				if (!name.endsWith(file)) continue

				const isAsset = (chunk as any).type === 'asset'
				const code = String(isAsset ? (chunk as any).source : (chunk as any).code)
				const hasNL = /\n$/.test(code)
				const next = code + (hasNL ? '' : '\n') + snippet + '\n'

				if (isAsset) (chunk as any).source = next
				else (chunk as any).code = next
			}
		},
	}
}

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	plugins: [appendDtsImport('import type {} from "./services"')],
	entry: {
		index: 'src/index.ts',
		services: 'src/services/index.ts',
		config: 'src/config.ts',
	},
	alias: {
		'~': valibotFormSrc,
	},
	env: {
		BUILD_OUTPUT: true,
		PLUXEL_HMR_SSR: false,
	},
	tsconfig: './tsconfig.json',
	dts: {
		resolver: 'tsc',
	},
	// 不要内联 core，未来可能要用来 build。
	external: ['@pluxel/core', '@pluxel/core/service'],
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: false,
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
