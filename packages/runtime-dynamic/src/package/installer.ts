import { readFile } from 'node:fs/promises'
import type { Context } from '@pluxel/core'
import { addDependency, removeDependency, type OperationOptions } from 'nypm'
import { resolve } from 'pathe'

import {
	canResolveFromCwd,
	getCachedResolver,
	getOxcResolveCache,
	installedPackageJsonPath,
	resolvePackageJsonPathWithOxc,
} from '@pluxel/runtime/internal'
import type { NormalizedPackageSpecifier, PackageSpecifierInput } from './specifiers'
import type { PackageInstallResult, ResolvedInstallOptions } from './types'

type PackageJson = {
	name?: string
	version?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean; dev?: boolean }>
	[key: string]: unknown
}

export type PackageLogFn = (
	level: 'info' | 'warn' | 'error',
	event: string,
	payload?: Record<string, unknown>,
	message?: string,
) => void

export type NormalizeSpecFn = (input: PackageSpecifierInput) => NormalizedPackageSpecifier

function toNypmOperationOptions(options: ResolvedInstallOptions): OperationOptions {
	const {
		force: _force,
		installPeerDependencies: _installPeerDependencies,
		...operationOptions
	} = options
	return {
		...operationOptions,
		silent: operationOptions.silent ?? false,
	} as OperationOptions
}

export class PackageInstaller {
	private readonly installedCache = new Map<
		string,
		{
			at: number
			entries: Array<{
				spec: NormalizedPackageSpecifier
				installedVersion?: string
				requestedVersion?: string
			}>
		}
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

		const cache = getOxcResolveCache(this.sharedResolveCache())
		return canResolveFromCwd(cwd, name, cache, {
			group: 'package:installer-resolver',
			limit: 16,
		})
	}

	invalidateCache(cwd?: string) {
		if (cwd) this.installedCache.delete(cwd)
		else this.installedCache.clear()
	}

	async installTargetsWithLogs(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult[]> {
		if (specs.length === 0) return []
		const targets = specs.map((s) => s.target)
		const opOptions = toNypmOperationOptions(options)
		const opResult = await addDependency(targets, opOptions)
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
		if (specs.length === 0) return
		const targets = [...new Set(specs.map((s) => s.name))]
		const opOptions = toNypmOperationOptions(options)
		try {
			const opResult = await removeDependency(targets, opOptions)
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

	async readInstalledDependencies(params: { options: ResolvedInstallOptions }): Promise<
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
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.optionalDependencies,
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
		const normalized = [...unique.values()]
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

		const unique = (list: string[]) => [...new Set(list)]
		const installPeerGroup = async (list: string[], dev: boolean) => {
			if (list.length === 0) return
			const specsToInstall = unique(list).map((raw) => this.normalizeSpecifier(raw))
			const installed = await this.installTargetsWithLogs(specsToInstall, {
				...options,
				dev,
				installPeerDependencies: false,
			})
			installed.forEach((r) => {
				this.onPackageInstalled(r)
			})
		}

		if (peerDeps.length > 0) {
			await installPeerGroup(peerDeps, false)
		}
		if (peerDevDeps.length > 0) {
			await installPeerGroup(peerDevDeps, true)
		}
	}

	private async readPackageJsonSafe(pathOrName: string, cwd?: string): Promise<PackageJson> {
		try {
			if (!cwd) {
				const path = pathOrName.endsWith('package.json')
					? pathOrName
					: resolve(pathOrName, 'package.json')
				return await readPackageJsonFile(path)
			}

			const cache = getOxcResolveCache(this.sharedResolveCache())
			const resolver = getCachedResolver(cache, 'package:installer-package-json-resolver', [cwd], {
				limit: 16,
			})
			const resolvedPath = resolvePackageJsonPathWithOxc(resolver, pathOrName, {
				conditions: ['node', 'import', 'require', 'default'],
			})
			if (resolvedPath) return await readPackageJsonFile(resolvedPath)

			const directPath = installedPackageJsonPath(cwd, pathOrName)
			return directPath ? await readPackageJsonFile(directPath) : {}
		} catch {
			return {}
		}
	}

	private sharedResolveCache(): Map<string, unknown> | undefined {
		try {
			return this.ctx.scanService.resolverCache
		} catch {
			return undefined
		}
	}
}

async function readPackageJsonFile(path: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as PackageJson
}
