import type { ViteCompatPlugin } from './compat.ts'

type Options = {
	/**
	 * If provided, throws after rewrite when any of these strings still exist
	 * in the generated `.d.ts` assets.
	 */
	assertNotContains?: string[]
}

/**
 * Rewrite plain text inside generated `.d.ts` outputs.
 *
 * This is intentionally simple (string replacement, longest-first) and is useful
 * for vendoring internal packages into a public facade while ensuring private
 * module specifiers never leak into published type declarations.
 */
export function rewriteDtsText(
	replacements: Record<string, string>,
	options: Options = {},
): ViteCompatPlugin {
	const exts = /\.d\.(?:mts|cts|ts)$/i
	const entries = Object.entries(replacements).sort((a, b) => b[0].length - a[0].length)

	return {
		name: 'rewrite-dts-text',
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
				for (const [from, to] of entries) {
					code = code.split(from).join(to)
				}

				if (options.assertNotContains?.length) {
					for (const needle of options.assertNotContains) {
						if (code.includes(needle)) {
							throw new Error(
								`[rewriteDtsText] "${file}" still contains forbidden text: ${JSON.stringify(needle)}`,
							)
						}
					}
				}

				set(code)
			}
		},
	}
}
