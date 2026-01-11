import { normalize as normalizePath, resolve as resolvePath } from 'pathe'

import type { NormalizedPackageSpecifier, PackageSpecifierSnapshot } from '../specifiers'
import type { ResolvedInstallOptions } from './internal-types'
import {
	CURRENT_STATE_SCHEMA,
	type LegacyPackageStatePayload,
	type PackageStatePayload,
	type PersistedPackageEntry,
} from './state-store'
import type { InstallOptions } from './types'

export function resolveStateFilePath(file?: string): string {
	if (file) return resolvePath(file)
	return resolvePath(process.cwd(), 'data', 'hmr', 'package-state.json')
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
			...(resolved.env ?? {}),
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
	return Array.from(map.values())
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

export function normalizeStatePayload(
	payload: PackageStatePayload | LegacyPackageStatePayload | null,
): PackageStatePayload | null {
	if (!payload) return null
	if ('schema' in payload) {
		if ((payload as PackageStatePayload).schema === CURRENT_STATE_SCHEMA) {
			return payload as PackageStatePayload
		}
		if ((payload as PackageStatePayload).schema === 2) {
			const converted = payload as PackageStatePayload
			return {
				...converted,
				schema: CURRENT_STATE_SCHEMA,
				blocked: converted.blocked ?? [],
			}
		}
	}
	const legacy = payload as LegacyPackageStatePayload
	const packages: PersistedPackageEntry[] =
		legacy.packages?.map((item) => {
			const base: PersistedPackageEntry = {
				spec: item.spec as PackageSpecifierSnapshot,
				resolution: item.resolution,
				moduleId: item.moduleId,
				isAnchor: item.isAnchor,
				loadedAt: item.loadedAt,
				manifestPath: undefined,
				manifestVersion: undefined,
				resolvedVersion: undefined,
				dependOn: [],
			}
			if (item.installStatus) {
				base.install = { status: item.installStatus, at: item.loadedAt }
			}
			return base
		}) ?? []

	return {
		schema: CURRENT_STATE_SCHEMA,
		generatedAt: legacy.generatedAt,
		packages,
		issues: [],
		blocked: [],
	}
}
