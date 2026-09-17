import { definePluxelVitestConfig } from '@pluxel/test/vitest'
export default definePluxelVitestConfig({
	pluxel: {
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
	},
})
