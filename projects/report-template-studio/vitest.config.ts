import { definePluxelVitestConfig } from '@pluxel/test/vitest'
export default definePluxelVitestConfig({
	test: { include: ['tests/**/*.test.ts'], testTimeout: 60000, hookTimeout: 60000 },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
