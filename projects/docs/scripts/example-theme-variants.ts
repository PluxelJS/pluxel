import type { Plugin } from 'vite-plus'

/** Two real code versions share the source entry that Pluxel lowering canonicalizes. */
export function exampleThemeVariants(): Plugin {
	return {
		name: 'docs:example-theme-variants',
		enforce: 'pre',
		transform(code, id) {
			const [file, query] = id.split('?', 2)
			if (!file?.endsWith('/src/examples/typst/theme-plugin.ts') || !query) return undefined
			const version = new URLSearchParams(query).get('example-theme')
			if (version === null) return undefined
			if (version !== 'color') this.error(`Unsupported example theme version: ${version}`)
			const declaration = "const themeVersion: ThemeVersion = 'classic'"
			if (code.split(declaration).length !== 2)
				this.error('The example ThemePlugin version declaration must appear exactly once')
			return {
				code: code.replace(declaration, "const themeVersion: ThemeVersion = 'color'"),
				map: null,
			}
		},
	}
}
