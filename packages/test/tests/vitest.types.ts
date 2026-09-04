import { definePluxelVitestConfig, type PluxelVitestConfig } from '@pluxel/test/vitest'

const vitestConfig = {
	test: { include: ['tests/**/*.test.ts'], passWithNoTests: false },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
} satisfies PluxelVitestConfig

definePluxelVitestConfig(vitestConfig)

type Equal<Actual, Expected> =
	(<Value>() => Value extends Actual ? 1 : 2) extends <Value>() => Value extends Expected ? 1 : 2
		? true
		: false
type Assert<Condition extends true> = Condition

// The preset accepts exactly one optional Vite-compatible config object; its former second
// toolchain options argument must not reappear as a parallel configuration path.
type _definePluxelVitestConfigTakesOneObject = Assert<
	Equal<Parameters<typeof definePluxelVitestConfig>, [config?: PluxelVitestConfig]>
>

definePluxelVitestConfig({
	pluxel: {
		// @ts-expect-error Test discovery belongs to Vitest's native `test` namespace.
		passWithNoTests: false,
	},
})
