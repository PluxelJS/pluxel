import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: { include: ['tests/browser.smoke.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts'] },
})
