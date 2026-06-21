import { existsSync } from 'node:fs'

import { resolve } from 'pathe'

import {
	createOxcResolver,
	type OxcResolveCache,
	type OxcResolver,
	getCachedOxcResolver,
	normalizeOxcResolveDirectories,
} from './oxc-resolver'
import { hasNodeModulesPackageJson, toBasePackage } from './node-modules'
export { toBasePackage } from './node-modules'

export const RESOLVE_CHECK_CONDITIONS = ['node', 'import', 'require', 'default'] as const
export type ResolveMode = 'direct' | 'distPreferEsm'
export type ResolvePolicy = {
	mode?: ResolveMode
	conditions?: readonly string[]
}

export function getCachedResolver(
	cache: OxcResolveCache,
	group: string,
	from: readonly string[],
	opts?: { limit?: number },
): OxcResolver {
	const normalizedFrom = normalizeOxcResolveDirectories(from)
	if (normalizedFrom.length === 0) {
		throw new Error('[runtime:resolution] Resolver "from" list is empty.')
	}

	const key = normalizedFrom.join('|')
	return getCachedOxcResolver(cache, group, key, () => createOxcResolver(normalizedFrom), {
		limit: opts?.limit ?? 32,
	})
}

export function resolveModulePath(
	resolver: OxcResolver,
	id: string,
	policy?: ResolvePolicy,
): string | null {
	const mode = policy?.mode ?? 'direct'
	const conditions = policy?.conditions?.length ? policy.conditions : undefined

	const resolveWith = (conds?: readonly string[]) => {
		const options: { try: true; conditions?: readonly string[] } = { try: true }
		if (conds && conds.length > 0) options.conditions = conds
		const resolved = resolver.resolveModulePath(id, options)
		return typeof resolved === 'string' && resolved.length > 0 ? resolved : null
	}

	if (
		mode === 'distPreferEsm' &&
		conditions &&
		conditions.includes('import') &&
		conditions.includes('require')
	) {
		const esm = resolveWith(conditions.filter((c) => c !== 'require'))
		if (esm) return esm
		const cjs = resolveWith(conditions.filter((c) => c !== 'import'))
		if (cjs) return cjs
		return null
	}

	return resolveWith(conditions)
}

/**
 * Best-effort "is this package available from this cwd?" check.
 *
 * Fast path:
 * - if `node_modules` exists, a direct `node_modules/<pkg>/package.json` entry counts as available.
 *
 * Fallback:
 * - use the shared OXC resolver to see whether the specifier can be resolved.
 */
export function canResolveFromCwd(
	cwd: string,
	specifier: string,
	resolveCache: OxcResolveCache,
	opts?: {
		group?: string
		limit?: number
		conditions?: readonly string[]
	},
): boolean {
	const baseSpecifier = toBasePackage(specifier)
	const cwdAbs = resolve(cwd)
	const nodeModulesDir = resolve(cwdAbs, 'node_modules')

	// If the workspace has a node_modules, treat a direct entry (dir or symlink) as "installed in host".
	// This is important for pnpm workspace links where resolution returns the real path outside node_modules.
	if (existsSync(nodeModulesDir)) {
		return hasNodeModulesPackageJson(nodeModulesDir, baseSpecifier)
	}

	const resolver = getCachedResolver(
		resolveCache,
		opts?.group ?? 'runtime:cwd-resolver',
		[cwdAbs],
		{
			limit: opts?.limit ?? 32,
		},
	)

	try {
		return (
			resolveModulePath(resolver, baseSpecifier, {
				conditions: opts?.conditions ?? RESOLVE_CHECK_CONDITIONS,
			}) !== null
		)
	} catch {
		return false
	}
}
