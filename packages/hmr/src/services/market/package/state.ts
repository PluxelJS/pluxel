import {
	CURRENT_STATE_SCHEMA,
	PackageStateStore,
	type PackageStatePayload,
	type PersistedLoadIssue,
	type PersistedPackageEntry,
} from './state-store'
import { toSnapshot as specToSnapshot } from '../specifiers'
import type { PackageLoadIssue, PackageLoadResult, PackageMetadata } from './types'

export class PackageState {
	private persistenceEnabled = true
	private readonly loaded = new Map<string, PackageLoadResult>()
	private readonly issues = new Map<string, PackageLoadIssue>()
	private readonly blocked = new Set<string>()
	private readonly dependencyIndex = new Map<string, Set<string>>()

	constructor(
		private readonly store: PackageStateStore,
		private readonly getErrorStack: (error: unknown) => string | undefined,
	) {}

	disablePersistence() {
		this.persistenceEnabled = false
	}

	enablePersistence() {
		this.persistenceEnabled = true
	}

	requestPersist() {
		this.schedulePersist()
	}

	registerRecord(record: PackageLoadResult) {
		const previous = this.loaded.get(record.spec.name)
		if (previous) this.untrackDependencies(previous)
		this.trackDependencies(record)
		this.loaded.set(record.spec.name, record)
		this.blocked.delete(record.spec.name)
		this.schedulePersist()
	}

	clearRecord(name: string) {
		const previous = this.loaded.get(name)
		if (!previous) return
		this.untrackDependencies(previous)
		this.loaded.delete(name)
		this.schedulePersist()
	}

	recordIssue(issue: PackageLoadIssue) {
		this.issues.set(issue.spec.name, issue)
		this.schedulePersist()
	}

	clearIssue(name: string) {
		if (this.issues.delete(name)) {
			this.schedulePersist()
		}
	}

	block(name: string) {
		if (this.blocked.has(name)) return
		this.blocked.add(name)
		this.schedulePersist()
	}

	unblock(name: string) {
		if (this.blocked.delete(name)) {
			this.schedulePersist()
		}
	}

	isBlocked(name: string): boolean {
		return this.blocked.has(name)
	}

	hasLoaded(name: string): boolean {
		return this.loaded.has(name)
	}

	getLoaded(name: string): PackageLoadResult | undefined {
		return this.loaded.get(name)
	}

	getIssue(name: string): PackageLoadIssue | undefined {
		return this.issues.get(name)
	}

	loadedEntries(): Iterable<PackageLoadResult> {
		return this.loaded.values()
	}

	issueEntries(): Iterable<PackageLoadIssue> {
		return this.issues.values()
	}

	loadedNames(): string[] {
		return Array.from(this.loaded.keys())
	}

	issueNames(): string[] {
		return Array.from(this.issues.keys())
	}

	listIssues(): PackageLoadIssue[] {
		return Array.from(this.issues.values())
	}

	getDependencies(name: string): string[] {
		const record = this.loaded.get(name)
		return record ? [...record.dependOn] : []
	}

	getDependents(name: string): string[] {
		const set = this.dependencyIndex.get(name)
		return set ? Array.from(set) : []
	}

	removeDependentsOf(name: string) {
		for (const [dep, set] of this.dependencyIndex.entries()) {
			set.delete(name)
			if (!set.size) {
				this.dependencyIndex.delete(dep)
			}
		}
	}

	private trackDependencies(record: PackageMetadata) {
		for (const dep of record.dependOn ?? []) {
			const trimmed = dep.trim()
			if (!trimmed) continue
			const set = this.dependencyIndex.get(trimmed) ?? new Set<string>()
			set.add(record.spec.name)
			this.dependencyIndex.set(trimmed, set)
		}
	}

	private untrackDependencies(record: PackageMetadata) {
		for (const dep of record.dependOn ?? []) {
			const trimmed = dep.trim()
			if (!trimmed) continue
			const set = this.dependencyIndex.get(trimmed)
			if (!set) continue
			set.delete(record.spec.name)
			if (!set.size) this.dependencyIndex.delete(trimmed)
		}
	}

	private schedulePersist() {
		if (!this.persistenceEnabled) return
		this.store.scheduleWrite(this.buildPayload())
	}

	private buildPayload(): PackageStatePayload {
		const packages: PersistedPackageEntry[] = []
		for (const record of this.loaded.values()) {
			const entry: PersistedPackageEntry = {
				spec: specToSnapshot(record.spec),
				resolution: record.resolution,
				moduleId: record.moduleId,
				isAnchor: record.isAnchor,
				loadedAt: record.loadedAt,
				dependOn: record.dependOn ?? [],
				manifestPath: record.manifestPath,
				manifestVersion: record.manifestVersion,
				resolvedVersion: record.resolvedVersion,
			}
			if (record.install) {
				entry.install = { status: record.install.status, at: record.install.installedAt }
			}
			packages.push(entry)
		}

		const issues: PersistedLoadIssue[] = []
		for (const issue of this.issues.values()) {
			issues.push({
				spec: specToSnapshot(issue.spec),
				source: issue.source,
				message: issue.message,
				moduleId: issue.moduleId,
				recordedAt: issue.recordedAt,
				stack: issue.stack ?? this.getErrorStack(issue.error),
			})
		}

		return {
			schema: CURRENT_STATE_SCHEMA,
			generatedAt: new Date().toISOString(),
			packages,
			issues,
			blocked: Array.from(this.blocked),
		}
	}
}
