import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: {
		index: 'src/index.ts',
		react: 'src/react.tsx',
	},
	tsconfig: './tsconfig.json',
	format: ['esm'],
	sourcemap: true,
	clean: true,
	dts: { resolver: 'oxc' },
	external: ['react', 'react/jsx-runtime'],
})
