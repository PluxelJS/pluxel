const DEFAULT_FRONTEND_RESOLVE_CONDITIONS = [
	'import',
	'module',
	'browser',
	'development',
	'production',
	'default',
] as const

export const PLUXEL_UI_DEDUPE_PACKAGES = [
	'react',
	'react-dom',
	'@mantine/core',
	'@mantine/hooks',
	'@mantine/notifications',
	'@mantine/dates',
] as const

export const PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE = [
	'react',
	'react-dom',
	'@mantine/core',
	'@mantine/hooks',
	'@mantine/notifications',
	'@tabler/icons-react',
] as const

export const PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER =
	'@tabler/icons-react/dist/esm/icons/index.mjs' as const

export function buildPluxelFrontendResolveConditions(env = process.env.NODE_ENV): string[] {
	const extras =
		env &&
		!DEFAULT_FRONTEND_RESOLVE_CONDITIONS.includes(
			env as (typeof DEFAULT_FRONTEND_RESOLVE_CONDITIONS)[number],
		)
			? [env]
			: []
	return [...new Set(['@pluxel/source', ...DEFAULT_FRONTEND_RESOLVE_CONDITIONS, ...extras])]
}

export function createPluxelUiChunkGroups() {
	return [
		{
			name: 'react',
			test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/,
			priority: 50,
		},
		{
			name: 'mantine',
			test: /[\\/]node_modules[\\/]@mantine[\\/]/,
			priority: 40,
		},
		{
			name: 'emotion',
			test: /[\\/]node_modules[\\/]@emotion[\\/]/,
			priority: 30,
		},
		{
			name: 'tanstack',
			test: /[\\/]node_modules[\\/]@tanstack[\\/]/,
			priority: 28,
		},
		{
			name: 'graphql',
			test: /[\\/]node_modules[\\/](@gqlens|graphql)[\\/]/,
			priority: 26,
		},
		{
			name: 'mf-runtime',
			test: /[\\/]node_modules[\\/]@module-federation[\\/]/,
			priority: 24,
		},
		{
			name: 'dnd-kit',
			test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/,
			priority: 22,
		},
		{
			name: 'tabler',
			test: /[\\/]node_modules[\\/]@tabler[\\/]icons-react[\\/]/,
			priority: 20,
		},
		{
			name: 'vendor',
			test: /[\\/]node_modules[\\/]/,
			priority: 0,
			minSize: 10 * 1024,
		},
	] as const
}
