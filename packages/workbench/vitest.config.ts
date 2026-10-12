import { definePluxelVitestConfig } from '@pluxel/test/vitest'
export default definePluxelVitestConfig({
	oxc: { decorator: { legacy: true } },
	test: { include: ['tests/**/*.test.{ts,tsx}'] },
	pluxel: {
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
	},
})
