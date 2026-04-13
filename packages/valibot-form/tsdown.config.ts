import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'react',
			'react-dom',
			'@tanstack/react-form',
			'@mantine/core',
			'@mantine/hooks',
			'@dnd-kit/core',
			'@dnd-kit/modifiers',
			'@dnd-kit/sortable',
			'@dnd-kit/utilities',
			'@tabler/icons-react',
		],
	},
	entry: {
		index: './src/index.ts',
		web: './src/web/index.ts',
	},
	alias: {},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	// 应该把该包内容交给外部引用，不需要在我们的构建产物里 minify。
	minify: false,
	treeshake: true,
	plugins: [],
})
