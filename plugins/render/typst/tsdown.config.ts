import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: {
		index: 'src/index.ts',
		browser: 'src/browser/preview.ts',
		wasm: 'src/wasm.ts',
		template: 'src/template.ts',
		tiptap: 'src/tiptap/index.ts',
		'tiptap/react': 'src/tiptap/react.tsx',
	},
	deps: { neverBundle: [/^@tiptap\//, /^react(?:\/|$)/] },
	copy: [{ from: 'src/tiptap/style.css', to: 'dist/tiptap', flatten: true }],
	exports: {
		customExports(exports, { isPublish }) {
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
