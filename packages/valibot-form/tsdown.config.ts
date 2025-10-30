import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/index.ts',
		web: './src/web/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	external: [
		'valibot',
		'react',
		'react-dom',
		'@tanstack/react-form',
		'@mantine/core',
		'@dnd-kit/core',
		'@dnd-kit/modifiers',
		'@dnd-kit/sortable',
		'@dnd-kit/utilities',
		'@tabler/icons-react',
	],
})
