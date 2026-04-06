import { normalize as normalizePath, resolve as resolvePath } from 'pathe'
import { resolveRuntimeStoragePaths } from '../../../runtime/paths'
import type { ResolvedInstallOptions } from './internal-types'
import type { NormalizedPackageSpecifier } from './specifiers'
import type { InstallOptions } from './types'

export function resolveStateFilePath(file?: string): string {
	return file ? resolvePath(file) : resolveRuntimeStoragePaths(process.cwd()).packageStateFile
}

export function resolveInstallDefaults(
	options: InstallOptions | undefined,
	inWorkspace: boolean,
	workspaceRoot: string | null,
): ResolvedInstallOptions {
	const safe = options ?? {}
	const cwd = safe.cwd ?? workspaceRoot ?? process.cwd()
	const resolved: ResolvedInstallOptions = {
		cwd,
		dev: safe.dev ?? false,
		installPeerDependencies: safe.installPeerDependencies ?? false,
		force: safe.force ?? false,
		workspace: safe.workspace ?? inWorkspace,
	}
	if (safe.env !== undefined) resolved.env = safe.env
	if (safe.silent !== undefined) resolved.silent = safe.silent
	if (safe.packageManager !== undefined) resolved.packageManager = safe.packageManager
	if (safe.global !== undefined) resolved.global = safe.global
	if (safe.dry !== undefined) resolved.dry = safe.dry
	if (!resolved.workspace && inWorkspace) {
		resolved.env = {
			...resolved.env,
			PNPM_IGNORE_WORKSPACE_ROOT_CHECK: 'true',
			npm_config_ignore_workspace_root_check: 'true',
		}
	}
	return resolved
}

export function normalizeRoots(roots: string[]): string[] {
	const seen = new Set<string>()
	return roots.filter((r) => {
		const normalized = normalizePath(r)
		if (seen.has(normalized)) return false
		seen.add(normalized)
		return true
	})
}

export function dedupeByName(specs: NormalizedPackageSpecifier[]): NormalizedPackageSpecifier[] {
	const map = new Map<string, NormalizedPackageSpecifier>()
	for (const spec of specs) {
		if (!map.has(spec.name)) {
			map.set(spec.name, spec)
		}
	}
	return [...map.values()]
}

export function parseDependOn(value: unknown): string[] {
	if (!value) return []
	const collect = Array.isArray(value) ? value : [value]
	const normalized: string[] = []
	for (const item of collect) {
		if (typeof item !== 'string') continue
		const trimmed = item.trim()
		if (!trimmed) continue
		if (!normalized.includes(trimmed)) normalized.push(trimmed)
	}
	return normalized
}

export function isManagedPackageName(name: string): boolean {
	if (!name) return false
	return /^(?:@[^/]+\/)?pluxel-plugin\b/.test(name)
}
