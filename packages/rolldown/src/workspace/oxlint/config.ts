export const pluxelOxlintIgnorePatterns = [
	'**/dist/**',
	// Compile-only API probes are verified by `tsc`; they are deliberately not executable
	// Plugin source and must not be evaluated by the source-semantic lint rules.
	'**/*.typecheck.ts',
	'**/*.typecheck.tsx',
	'**/*.typecheck.mts',
	'**/*.typecheck.cts',
	'packages/**/__fixtures__/**',
	'packages/**/tests/fixtures/**',
	'packages/**/__tests__/fixtures/**',
	'packages/workbench-app/src/app/router/routeTree.gen.ts',
] as const
