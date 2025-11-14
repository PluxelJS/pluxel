import { defineConfig } from 'tsdown'

// rewrite-dts-augment.ts
function escapeRE(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 仅重写 d.ts 中的「模块补充」模块名：
 *   declare module '<from>' { ... }  =>  declare module '<to>' { ... }
 */
export function rewriteDtsModuleAugmentations(map: Record<string, string>) {
	const exts = /\.d\.(?:mts|cts|ts)$/i
	const entries = Object.entries(map).map(([from, to]) => {
		const re = new RegExp(
			// 捕获 "declare module " + 引号 + from + 同引号
			`(declare\\s+module\\s+)(['"])${escapeRE(from)}\\2`,
			'g',
		)
		return { re, to }
	})

	return {
		name: 'rewrite-dts-module-augmentations',
		generateBundle(_, bundle) {
			for (const file of Object.keys(bundle)) {
				if (!exts.test(file)) continue
				const chunk: any = bundle[file]
				const get = () => (chunk.type === 'asset' ? String(chunk.source) : String(chunk.code))
				const set = (code: string) => {
					if (chunk.type === 'asset') chunk.source = code
					else chunk.code = code
				}

				let code = get()
				for (const { re, to } of entries) {
					// 只改「declare module」行，不触及 import/export
					code = code.replace(re, (_, head, q) => `${head}${q}${to}${q}`)
				}
				set(code)
			}
		},
	}
}

const moduleAugmentationMap = {
	'@pluxel/context': '@pluxel/core',
}

const createModuleRewritePlugin = () => rewriteDtsModuleAugmentations(moduleAugmentationMap)

const transformOptions = {
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
}

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: 'src/index.ts',
		services: 'src/services/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	plugins: [createModuleRewritePlugin()],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions(options, _format, context) {
		options.transform = {
			...(options.transform ?? {}),
			...transformOptions,
		}

		if (!context.cjsDts) return

		const basePlugins = options.plugins
			? Array.isArray(options.plugins)
				? options.plugins
				: [options.plugins]
			: []

		options.plugins = [...basePlugins, createModuleRewritePlugin()]
		return options
	},
})
