import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: './src/index.ts',
		web: './src/web/index.ts',
	},
	alias: {},
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	// 应该把该包内容交给外部引用，不需要在我们的构建产物里 minify。
	minify: false,
	treeshake: true,
	plugins: [],
	external: [
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
