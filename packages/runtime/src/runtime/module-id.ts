import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'pathe'
import type { PluginNodeAddressSnapshot, PluginNodeSlot } from '@pluxel/core'
import { getOxcResolveCache } from '../services/runtime/shared/oxc-resolver'
import {
	getCachedResolver,
	RESOLVE_CHECK_CONDITIONS,
	resolveModulePath,
} from '../services/runtime/shared/resolution'

type RuntimeModuleLookupContext = {
	registry?: {
		internNodeAddress?: (address: PluginNodeAddressSnapshot) => PluginNodeSlot
		getRuntimeModuleId?: (id: PluginNodeSlot) => string | undefined
	}
}

// Internal runtime ownership lookup used by HMR/worker/extension helpers.
// Returns a module id, not a filesystem path; call resolveModuleIdBaseDir for path resolution.
export function findRuntimeModuleId(
	ctx: RuntimeModuleLookupContext,
	owner: PluginNodeAddressSnapshot,
): string | null {
	const node = ctx.registry?.internNodeAddress?.(owner)
	return node ? (ctx.registry?.getRuntimeModuleId?.(node) ?? null) : null
}

export function resolveModuleIdPath(moduleId: string, cwd = process.cwd()): string | null {
	const normalized = String(moduleId ?? '').trim()
	if (!normalized) return null
	if (isAbsolute(normalized)) return normalized

	try {
		const resolver = getCachedResolver(
			getOxcResolveCache(),
			'runtime:module-id-resolver',
			getResolveBaseDirs(cwd),
			{ limit: 16 },
		)
		return resolveModulePath(resolver, normalized, { conditions: RESOLVE_CHECK_CONDITIONS })
	} catch {
		return null
	}
}

export function resolveModuleIdBaseDir(moduleId: string, cwd = process.cwd()): string | null {
	const resolved = resolveModuleIdPath(moduleId, cwd)
	if (!resolved) return null

	try {
		const stats = statSync(resolved)
		if (stats.isDirectory()) return resolved
	} catch {
		// Best effort: treat unresolved stat errors as file paths.
	}

	return dirname(resolved)
}

function getResolveBaseDirs(cwd: string): string[] {
	const bases = [resolve(cwd)]
	const entryScript = process.argv[1]
	if (typeof entryScript === 'string' && entryScript.trim() && isAbsolute(entryScript)) {
		bases.push(dirname(entryScript))
	}
	return bases
}
