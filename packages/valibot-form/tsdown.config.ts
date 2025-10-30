import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/index.ts',
		web: './src/web/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	// 应该把该包内容交给外部引用然后 treeshake，不需要在我们的构建产物里 minify 和 treeshake。
	minify: false,
	treeshake: false,
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
