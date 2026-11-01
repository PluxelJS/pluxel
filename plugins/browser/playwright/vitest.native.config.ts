import { definePluxelVitestConfig } from '@pluxel/test/vitest'

// Explicit opt-in: requires an installed Chromium, and owns its isolated server process.
export default definePluxelVitestConfig({
	test: { include: ['tests/native-provider.smoke.ts'], testTimeout: 60_000, hookTimeout: 30_000 },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
