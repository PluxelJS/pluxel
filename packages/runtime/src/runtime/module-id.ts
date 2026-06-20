import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'pathe'

type RuntimeModuleLookupContext = {
	registry?: {
		getRuntimeModuleId?: (id: string) => string | undefined
	}
	loader?: {
		api?: {
			registry?: {
				findModuleIdByName?: (name: string) => string | undefined | null
			}
		}
	}
}

// Internal runtime ownership lookup used by HMR/worker/extension helpers.
// Returns a module id, not a filesystem path; call resolveModuleIdBaseDir for path resolution.
export function findRuntimeModuleId(
	ctx: RuntimeModuleLookupContext,
	pluginName: string | null | undefined,
): string | null {
	const name = String(pluginName ?? '').trim()
	if (!name) return null
	return (
		ctx.registry?.getRuntimeModuleId?.(name) ??
		ctx.loader?.api?.registry?.findModuleIdByName?.(name) ??
		null
	)
}

export function resolveModuleIdPath(moduleId: string, cwd = process.cwd()): string | null {
	const normalized = String(moduleId ?? '').trim()
	if (!normalized) return null
	if (isAbsolute(normalized)) return normalized

	for (const candidate of getRequireBases(cwd)) {
		try {
			const req = createRequire(candidate)
			return req.resolve(normalized)
		} catch {
			// Try the next base.
		}
	}

	return null
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

function getRequireBases(cwd: string): string[] {
	const bases = [resolve(cwd, '__pluxel_runtime_module_id__.mjs')]
	const entryScript = process.argv[1]
	if (typeof entryScript === 'string' && entryScript.trim() && isAbsolute(entryScript)) {
		bases.push(entryScript)
		bases.push(resolve(dirname(entryScript), '__pluxel_runtime_module_id__.mjs'))
	}
	return bases
}
