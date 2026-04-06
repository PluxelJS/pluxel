import type { ViteCompatPlugin } from './compat'

type Options = {
	/** File name filter; defaults to excluding sourcemaps. */
	include?: (fileName: string) => boolean
}

/**
 * Fail the build if any generated bundle asset/chunk contains forbidden text.
 *
 * Useful as a safety net to ensure private module specifiers (or internal markers)
 * never leak into published artifacts.
 */
export function assertBundleNoText(forbidden: string[], options: Options = {}): ViteCompatPlugin {
	const include = options.include ?? ((file) => !/\.map$/i.test(file))
	const needles = forbidden.filter(Boolean)

	return {
		name: 'assert-bundle-no-text',
		generateBundle(_, bundle) {
			for (const file of Object.keys(bundle)) {
				if (!include(file)) continue
				const chunk: any = bundle[file]
				const code = chunk.type === 'asset' ? String(chunk.source) : String(chunk.code)
				for (const needle of needles) {
					if (!needle) continue
					if (code.includes(needle)) {
						throw new Error(
							`[assertBundleNoText] "${file}" contains forbidden text: ${JSON.stringify(needle)}`,
						)
					}
				}
			}
		},
	}
}
