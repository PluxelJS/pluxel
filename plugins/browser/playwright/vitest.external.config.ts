import { definePluxelVitestConfig } from '@pluxel/test/vitest'

// Explicit opt-in: never included by the normal package test command.
export default definePluxelVitestConfig({
	test: { include: ['tests/external-browser.smoke.ts'], testTimeout: 90_000, hookTimeout: 30_000 },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
