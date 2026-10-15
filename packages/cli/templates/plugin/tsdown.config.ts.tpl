import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: {
		index: 'src/{{pluginName}}.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})
