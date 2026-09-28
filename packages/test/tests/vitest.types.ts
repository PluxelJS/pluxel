import { definePluxelVitestConfig, type PluxelVitestConfig } from '@pluxel/test/vitest'

const vitestConfig = {
	test: { include: ['tests/**/*.test.ts'], passWithNoTests: false },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
} satisfies PluxelVitestConfig

definePluxelVitestConfig(vitestConfig)

// @ts-expect-error Toolchain options belong in the same config object's pluxel namespace.
definePluxelVitestConfig({}, { include: ['src/**/*.ts'] })

definePluxelVitestConfig({
	pluxel: {
		// @ts-expect-error Test discovery belongs to Vitest's native `test` namespace.
		passWithNoTests: false,
	},
})
