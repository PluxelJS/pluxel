import { isManagedPackageName } from './helpers'
import type { PackageInstaller } from './installer'
import type { PackageRuntime } from './runtime'
import type { NormalizedPackageSpecifier } from './specifiers'
import type { PackageState } from './state'
import type {
	InstallOptions,
	ListInstalledPackagesOptions,
	PackageInventoryEntry,
	PackageLoadIssue,
	ResolvedInstallOptions,
} from './types'

type ResolveInstallOptions = (overrides?: InstallOptions) => ResolvedInstallOptions

export class PackageInventoryService {
	constructor(
		private readonly state: PackageState,
		private readonly installer: PackageInstaller,
		private readonly runtime: PackageRuntime,
		private readonly resolveInstallOptions: ResolveInstallOptions,
		private readonly isInitialized: () => boolean,
	) {}

	async listInstalledPackages(
		options: ListInstalledPackagesOptions = {},
	): Promise<PackageInventoryEntry[]> {
		const entries = new Map<string, PackageInventoryEntry>()
		const includeUntracked = options.includeUntracked ?? false
		const addOrMerge = (next: PackageInventoryEntry) => {
			const existing = entries.get(next.spec.name)
			if (!existing) {
				entries.set(next.spec.name, next)
				return
			}
			const merged: PackageInventoryEntry = {
				spec: existing.spec,
				installedVersion: next.installedVersion ?? existing.installedVersion,
				requestedVersion: next.requestedVersion ?? existing.requestedVersion,
				loaded: existing.loaded || next.loaded,
				moduleId: next.moduleId ?? existing.moduleId,
				issues: existing.issues ?? next.issues,
				blocked: next.blocked ?? existing.blocked,
			}
			entries.set(next.spec.name, merged)
		}

		for (const record of this.state.loadedEntries()) {
			addOrMerge({
				spec: record.spec,
				installedVersion: record.resolvedVersion ?? record.manifestVersion,
				requestedVersion: record.spec.version ?? record.spec.tag,
				loaded: true,
				moduleId: record.moduleId,
				blocked: this.state.isBlocked(record.spec.name),
				issues: this.state.getIssue(record.spec.name)
					? [this.state.getIssue(record.spec.name)!]
					: undefined,
			})
		}

		for (const issue of this.state.issueEntries()) {
			addOrMerge({
				spec: issue.spec,
				loaded: false,
				blocked: this.state.isBlocked(issue.spec.name),
				issues: [issue],
			})
		}

		const managedNames = new Set<string>([...this.state.loadedNames(), ...this.state.issueNames()])
		const installedDeps = await this.installer.readInstalledDependencies({
			options: this.resolveInstallOptions(),
		})
		for (const dep of installedDeps) {
			const managed = managedNames.has(dep.spec.name) || isManagedPackageName(dep.spec.name)
			if (!includeUntracked && !managed) continue
			addOrMerge({
				spec: dep.spec,
				installedVersion: dep.installedVersion,
				requestedVersion: dep.requestedVersion,
				loaded: this.state.hasLoaded(dep.spec.name),
				blocked: this.state.isBlocked(dep.spec.name),
			})
		}

		return [...entries.values()]
	}

	listLoadIssues(): PackageLoadIssue[] {
		if (!this.isInitialized()) return []
		return this.state.listIssues()
	}

	getPackageSpecByModuleId(moduleId: string): NormalizedPackageSpecifier | undefined {
		const normalized = this.runtime.normalizeModuleId(moduleId)
		for (const record of this.state.loadedEntries()) {
			if (this.runtime.normalizeModuleId(record.moduleId) === normalized) {
				return record.spec
			}
		}
		for (const issue of this.state.issueEntries()) {
			if (issue.moduleId && this.runtime.normalizeModuleId(issue.moduleId) === normalized) {
				return issue.spec
			}
		}
		return undefined
	}

	getDependencies(name: string): string[] {
		return this.state.getDependencies(name)
	}

	getDependents(name: string): string[] {
		return this.state.getDependents(name)
	}
}
