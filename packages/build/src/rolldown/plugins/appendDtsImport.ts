import type { ViteCompatPlugin } from './compat'

export function appendDtsImport(snippet: string, files: string[]): ViteCompatPlugin {
	const exts = /\.d\.(?:mts|cts|ts)$/i
	const targets = files?.length ? [...files] : null
	return {
		name: 'append-dts-import',
		generateBundle(_, bundle) {
			for (const [name, chunk] of Object.entries(bundle)) {
				if (!exts.test(name)) continue
				if (targets && !targets.some((file) => name.endsWith(file))) continue

				const isAsset = (chunk as any).type === 'asset'
				const code = String(isAsset ? (chunk as any).source : (chunk as any).code)
				const hasNL = code.endsWith('\n')
				const next = code + (hasNL ? '' : '\n') + snippet + '\n'

				if (isAsset) (chunk as any).source = next
				else (chunk as any).code = next
			}
		},
	}
}
