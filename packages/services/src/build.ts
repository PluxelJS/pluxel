import { pluxel as applicationBuild, type PluxelApplicationBuildOptions } from '@pluxel/rolldown'

const serviceEntries = [
	'@pluxel/services/http',
	'@pluxel/services/node',
	'@pluxel/services/workers',
	'@pluxel/services/commands',
	'@pluxel/services/persistence',
	'@pluxel/services/vault',
	'@pluxel/services/management/access',
	'elysia',
	'elysia/ws',
	'@pluxel/commands',
] as const

/**
 * Build the official servicesPreset() combination. Defaults to a Workbench distribution.
 * sourceFrameworks adds shared entries for future dynamic Plugins; it installs no services.
 * Use @pluxel/rolldown directly for a custom service distribution.
 */
export function buildPreset(
	options: PluxelApplicationBuildOptions = {},
): ReturnType<typeof applicationBuild> {
	const variant = options.variant ?? 'workbench'
	return applicationBuild({
		...options,
		variant,
		sourceFrameworks: [
			...new Set([
				...serviceEntries,
				...(variant === 'workbench' ? ['@pluxel/workbench', '@pluxel/workbench/federation'] : []),
				...(options.sourceFrameworks ?? []),
			]),
		],
	})
}
