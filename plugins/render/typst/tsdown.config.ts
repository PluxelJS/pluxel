import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: {
		index: 'src/index.ts',
		browser: 'src/browser/preview.ts',
		wasm: 'src/wasm.ts',
		template: 'src/template.ts',
		source: 'src/source/node.ts',
		'source/browser': 'src/source/browser.ts',
		'source/library': 'src/source/library.ts',
		tiptap: 'src/tiptap/index.ts',
		'tiptap/react': 'src/tiptap/react.tsx',
	},
	deps: { neverBundle: [/^@tiptap\//, /^react(?:\/|$)/, /^@r4ai\//] },
	copy: [
		{ from: 'src/tiptap/style.css', to: 'dist/tiptap', flatten: true },
		{
			from: 'node_modules/@r4ai/typst-ast-web/typst_ast_bg.wasm',
			to: 'dist/source',
			flatten: true,
		},
	],
	exports: {
		customExports(exports, { isPublish }) {
			exports['./source/parser.wasm'] = isPublish
				? './dist/source/typst_ast_bg.wasm'
				: {
						'@pluxel/hmr': './dist/source/typst_ast_bg.wasm',
						default: './dist/source/typst_ast_bg.wasm',
					}
			exports['./tiptap/style.css'] = isPublish
				? './dist/tiptap/style.css'
				: {
						'@pluxel/hmr': './src/tiptap/style.css',
						default: './dist/tiptap/style.css',
					}
			return exports
		},
	},
	dts: { eager: true },
	format: ['esm'],
	sourcemap: true,
	clean: true,
})
