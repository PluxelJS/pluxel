import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		cli: 'src/cli.ts',
		workspace: 'src/workspace.ts',
		model: 'src/model.ts',
	},
	format: 'esm',
	dts: false,
	clean: true,
	deps: { neverBundle: [/^@pluxel\//, /^@tiptap\//, 'valibot'] },
})
