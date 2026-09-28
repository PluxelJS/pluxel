import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: './src/index.ts',
		internal: './src/internal.ts',
		argv: './src/argv.ts',
		mcp: './src/mcp.ts',
		capnweb: './src/capnweb.ts',
		typebox: './src/typebox.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm', 'cjs'],
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
		},
	},
})
