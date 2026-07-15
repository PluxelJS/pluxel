import { readFile } from 'node:fs/promises'

import { normalize as normalizePath, resolve as resolvePath } from 'pathe'
import { resolveRuntimeStoragePaths } from '@pluxel/runtime/internal'
import type { NormalizedPackageSpecifier } from './specifiers'
import type { InstallOptions, PluginPackageDependencies, ResolvedInstallOptions } from './types'

const MANAGED_PLUGIN_PATTERN = /^(?:@[^/]+\/)?pluxel-plugin(?:-|$)/i

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

export function parsePluginPackages(value: unknown): PluginPackageDependencies {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const entries: Array<[string, 'required' | 'optional']> = []
	for (const [name, mode] of Object.entries(value as Record<string, unknown>)) {
		const normalized = name.trim()
		if (normalized && (mode === 'required' || mode === 'optional')) {
			entries.push([normalized, mode])
		}
	}
	return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

export function isManagedPackageName(name: string): boolean {
	return MANAGED_PLUGIN_PATTERN.test(name)
}

export function createDebouncedTrigger(config: {
	delayMs: number
	run: () => void | Promise<void>
}): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null
	let pending = false

	return () => {
		pending = true
		if (timer) return
		timer = setTimeout(async () => {
			timer = null
			if (!pending) return
			pending = false
			await config.run()
		}, config.delayMs)
	}
}

export async function collectDeclaredPlugins(roots: string[]): Promise<Set<string>> {
	const result = new Set<string>()
	await Promise.all(
		roots.map(async (root) => {
			try {
				const pkgPath = resolvePath(root, 'package.json')
				const content = await readFile(pkgPath, 'utf8')
				const json: unknown = JSON.parse(content)
				const rootManifest = asRecord(json)
				collectDeps(asRecord(rootManifest?.dependencies), result)
				collectDeps(asRecord(rootManifest?.optionalDependencies), result)
				collectDeps(asRecord(rootManifest?.peerDependencies), result)
			} catch {
				// ignore unreadable roots
			}
		}),
	)
	return result
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') return undefined
	return value as Record<string, unknown>
}

function collectDeps(deps: Record<string, unknown> | undefined, out: Set<string>) {
	if (!deps) return
	for (const name of Object.keys(deps)) {
		if (MANAGED_PLUGIN_PATTERN.test(name)) out.add(name)
	}
}
