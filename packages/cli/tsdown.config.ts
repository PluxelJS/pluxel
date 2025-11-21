import { defineConfig } from 'tsdown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'

export default defineConfig({
	entry: './src/cli.ts',
	dts: {
		build: false,
		sourcemap: true,
	},
	copy: ['plop-templates'],
	plugins: [PreprocessorDirectives()],
	format: ['esm'],
	clean: true,
	minify: true,
	treeshake: true,
})
