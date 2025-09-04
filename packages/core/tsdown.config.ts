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

export default defineConfig({
	exports: false,
	entry: {
		index: 'src/index.ts',
		service: 'src/service/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	plugins: [
		rewriteDtsModuleAugmentations({
			'@pluxel/context': '.',
		}),
	],
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
