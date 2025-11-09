import { type ResolvedScanOptions, type ScanOptionsInput } from './types'

export const DEFAULT_SCAN_OPTIONS: ResolvedScanOptions = {
	conditions: ['@pluxel/source', 'node', 'import'],
	conservativeCandidates: [
		'index.ts',
		'index.mts',
		'index.cts',
		'index.js',
		'index.mjs',
		'index.cjs',
		'src/index.ts',
		'dist/index.js',
	],
	includeRoot: false,
	skipUnnamed: true,
	fallbackTsOnSingle: true,
	batchSize: 8,
	focusPackages: undefined,
}

export function resolveScanOptions(
	defaults: ResolvedScanOptions,
	overrides: ScanOptionsInput = {},
): ResolvedScanOptions {
	const focus = overrides.focusPackages ?? defaults.focusPackages
	const focusNormalized =
		focus && focus.length
			? Array.from(new Set(focus.map((f) => f.trim().toLowerCase()).filter(Boolean)))
			: undefined

	return {
		conditions: overrides.conditions ?? defaults.conditions,
		conservativeCandidates: overrides.conservativeCandidates ?? defaults.conservativeCandidates,
		includeRoot: overrides.includeRoot ?? defaults.includeRoot,
		skipUnnamed: overrides.skipUnnamed ?? defaults.skipUnnamed,
		fallbackTsOnSingle: overrides.fallbackTsOnSingle ?? defaults.fallbackTsOnSingle,
		batchSize: overrides.batchSize ?? defaults.batchSize,
		focusPackages: focusNormalized,
	}
}
