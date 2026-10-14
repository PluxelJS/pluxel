import { definePluxelVitestConfig } from '@pluxel/test/vitest'

// Explicit opt-in. Sends supplied images to the configured model and may submit official queries.
export default definePluxelVitestConfig({
	test: { include: ['tests/live.smoke.ts'], testTimeout: 600_000, hookTimeout: 30_000 },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts'] },
})
