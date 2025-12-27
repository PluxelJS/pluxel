import { createRequire } from 'node:module'

import type { Context } from '@pluxel/core'
import { addDependency, removeDependency } from 'nypm'
import type { OperationOptions } from 'nypm'
import { normalize as normalizePath } from 'pathe'
import { readPackageJSON } from 'pkg-types'

import type { NormalizedPackageSpecifier, PackageSpecifierInput } from '../specifiers'
import type { PackageInstallResult } from './types'
import type { ResolvedInstallOptions } from './internal-types'

export type PackageLogFn = (
	level: 'info' | 'warn' | 'error',
	event: string,
	payload?: Record<string, unknown>,
	message?: string,
) => void

export type NormalizeSpecFn = (input: PackageSpecifierInput) => NormalizedPackageSpecifier

export class PackageInstaller {
	private readonly installedCache = new Map<
		string,
		{ at: number; entries: Array<{ spec: NormalizedPackageSpecifier; installedVersion?: string; requestedVersion?: string }> }
	>()
	private readonly cacheTtlMs = 1000

	constructor(
		private readonly ctx: Context,
		private readonly normalizeSpecifier: NormalizeSpecFn,
		private readonly logEvent: PackageLogFn,
		private readonly onPackageInstalled: (result: PackageInstallResult) => void,
	) {}

	async dependencyExists(name: string, options: ResolvedInstallOptions): Promise<boolean> {
		const cwd = options.cwd ?? process.cwd()
		const resolver = createRequire(cwd.endsWith('/') ? cwd : `${cwd}/`)
		try {
			const resolved = resolver.resolve(name)
			return normalizePath(resolved).startsWith(normalizePath(cwd))
		} catch {
			return false
		}
	}

	invalidateCache(cwd?: string) {
		if (cwd) this.installedCache.delete(cwd)
		else this.installedCache.clear()
	}

	async installTargetsWithLogs(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult[]> {
		if (!specs.length) return []
		const targets = specs.map((s) => s.target)
		const opOptions: OperationOptions = { ...options, silent: options.silent ?? false }
		const opResult = await addDependency(targets as any, opOptions)
		if (opResult?.exec) {
			this.logEvent('info', 'install:pm_command', {
				targets,
				command: opResult.exec.command,
				args: opResult.exec.args,
				commandLine: `${opResult.exec.command} ${opResult.exec.args.join(' ')}`,
				cwd: options.cwd,
			})
		}

		const installedAt = Date.now()
		const results: PackageInstallResult[] = specs.map((spec) => ({
			spec,
			target: spec.target,
			status: 'installed',
			installedAt,
		}))

		if (options.installPeerDependencies && !options.dry) {
			await this.installPeerDependencies(specs, options)
		}

		return results
	}

	async removeTargetsWithLogs(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<void> {
		if (!specs.length) return
		const targets = Array.from(new Set(specs.map((s) => s.name)))
		const opOptions: OperationOptions = { ...options, silent: options.silent ?? false }
		try {
			const opResult = await removeDependency(targets as any, opOptions)
			if (opResult?.exec) {
				this.logEvent('info', 'remove:pm_command', {
					targets,
					command: opResult.exec.command,
					args: opResult.exec.args,
					commandLine: `${opResult.exec.command} ${opResult.exec.args.join(' ')}`,
					cwd: options.cwd,
				})
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (
				message.includes('ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS') ||
				message.includes('no such dependency found') ||
				message.includes('Cannot remove')
			) {
				this.logEvent('warn', 'remove:skip_missing', { targets, message })
				return
			}
			throw error
		}
	}

	async readInstalledDependencies(params: {
		options: ResolvedInstallOptions
	}): Promise<
		Array<{
			spec: NormalizedPackageSpecifier
			installedVersion?: string
			requestedVersion?: string
		}>
	> {
		const cwd = params.options.cwd ?? process.cwd()
		const cached = this.installedCache.get(cwd)
		const now = Date.now()
		if (cached && now - cached.at < this.cacheTtlMs) {
			return cached.entries
		}

		const pkg = await this.readPackageJsonSafe(cwd)
		const declared: Record<string, string> = {
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
			...(pkg.optionalDependencies ?? {}),
		}
		const entries: Array<{
			spec: NormalizedPackageSpecifier
			installedVersion?: string
			requestedVersion?: string
		}> = []

		for (const [name, requested] of Object.entries<string>(declared)) {
			try {
				const installed = await this.readPackageJsonSafe(name, cwd)
				const installedVersion =
					typeof installed?.version === 'string' ? installed.version : undefined
				const spec = this.normalizeSpecifier({
					name,
					version: installedVersion ?? requested ?? undefined,
				})
				entries.push({
					spec,
					installedVersion,
					requestedVersion: requested,
				})
			} catch {
				// ignore entries that cannot be read
			}
		}

		const unique = new Map<string, (typeof entries)[number]>()
		for (const entry of entries) {
			if (!unique.has(entry.spec.name)) unique.set(entry.spec.name, entry)
		}
		const normalized = Array.from(unique.values())
		this.installedCache.set(cwd, { at: now, entries: normalized })
		return normalized
	}

	private async installPeerDependencies(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<void> {
		if (options.dry) return
		const cwd = options.cwd ?? process.cwd()
		const existingPkg = await this.readPackageJsonSafe(cwd)
		const peerDeps: string[] = []
		const peerDevDeps: string[] = []

		for (const spec of specs) {
			const pkg = await this.readPackageJsonSafe(spec.name, cwd)
			if (!pkg?.peerDependencies || pkg.name !== spec.name) continue
			for (const [peer, version] of Object.entries<string>(pkg.peerDependencies ?? {})) {
				if (pkg.peerDependenciesMeta?.[peer]?.optional) continue
				if (existingPkg.dependencies?.[peer] || existingPkg.devDependencies?.[peer]) continue
				const entry = `${peer}@${version}`
				if (pkg.peerDependenciesMeta?.[peer]?.dev) peerDevDeps.push(entry)
				else peerDeps.push(entry)
			}
		}

		const unique = (list: string[]) => Array.from(new Set(list))
		const installPeerGroup = async (list: string[], dev: boolean) => {
			if (!list.length) return
			const specsToInstall = unique(list).map((raw) => this.normalizeSpecifier(raw))
			const installed = await this.installTargetsWithLogs(specsToInstall, {
				...options,
				dev,
				installPeerDependencies: false,
			})
			installed.forEach((r) => this.onPackageInstalled(r))
		}

		if (peerDeps.length) {
			await installPeerGroup(peerDeps, false)
		}
		if (peerDevDeps.length) {
			await installPeerGroup(peerDevDeps, true)
		}
	}

	private async readPackageJsonSafe(pathOrName: string, cwd?: string): Promise<any> {
		try {
			return await readPackageJSON(pathOrName, cwd ? { url: cwd } : undefined)
		} catch {
			return {}
		}
	}
}
