import { MANIFEST_PLUGIN_PACKAGES_FIELD } from '../../env'
import type { WorkspacePackageJson } from '../../../workspace/package-json'
import type { RuleContext } from '../types'

export function pluginDependencyRule(pkg: WorkspacePackageJson, context: RuleContext) {
	const versions = resolvePluginVersions(pkg, context)
	const messages: string[] = []
	const stalePackages = readGeneratedPluginPackages(pkg, context.manifestField).filter(
		(name) => !context.pluginUsages.has(name),
	)
	const staleRemovals = removeStalePeerDependencies(pkg, stalePackages)
	if (staleRemovals.length > 0) {
		messages.push(`stale peerDependencies removed ${staleRemovals.join(', ')}`)
	}

	const peerChanges = ensurePeerDependencies(pkg, versions)
	if (peerChanges.length > 0) messages.push(`peerDependencies set ${peerChanges.join(', ')}`)

	const dependencyRemovals = removeRuntimeDependencies(pkg, versions)
	if (dependencyRemovals.length > 0) {
		messages.push(`dependencies - ${dependencyRemovals.join(', ')}`)
	}

	const peerMetaChanges = syncOptionalPeerMetadata(pkg, context.pluginUsages)
	if (peerMetaChanges.length > 0) {
		messages.push(`peerDependenciesMeta updated ${peerMetaChanges.join(', ')}`)
	}

	const manifestUpdate = syncPluginPackages(pkg, context.pluginUsages, context.manifestField)
	if (manifestUpdate) {
		messages.push(
			`${context.manifestField}.${MANIFEST_PLUGIN_PACKAGES_FIELD} updated (${Object.entries(
				manifestUpdate,
			)
				.map(([name, mode]) => `${name}=${mode}`)
				.join(', ')})`,
		)
	}

	return messages.length > 0 ? messages : undefined
}

function resolvePluginVersions(pkg: WorkspacePackageJson, context: RuleContext) {
	const versions = new Map<string, string>()
	for (const name of context.pluginUsages.keys()) {
		const version =
			pkg.peerDependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.dependencies?.[name]
		if (!version) {
			throw new Error(
				`Plugin package dependency ${name} has no version range in peerDependencies, devDependencies, or dependencies`,
			)
		}
		versions.set(name, version)
	}
	return versions
}

function ensurePeerDependencies(pkg: WorkspacePackageJson, versions: Map<string, string>) {
	const peers = { ...pkg.peerDependencies }
	const updates: string[] = []
	for (const [name, version] of versions) {
		if (peers[name] === version) continue
		peers[name] = version
		updates.push(`${name}@${version}`)
	}
	if (updates.length > 0) pkg.peerDependencies = sortStringRecord(peers)
	return updates.sort((a, b) => a.localeCompare(b))
}

function removeRuntimeDependencies(pkg: WorkspacePackageJson, versions: Map<string, string>) {
	const source = pkg.dependencies
	if (!source) return []
	const removed: string[] = []
	for (const name of versions.keys()) {
		if (!(name in source)) continue
		delete source[name]
		removed.push(name)
	}
	if (Object.keys(source).length === 0) delete pkg.dependencies
	return removed.sort((a, b) => a.localeCompare(b))
}

function readGeneratedPluginPackages(pkg: WorkspacePackageJson, manifestField: string): string[] {
	const manifest = isRecord(pkg[manifestField]) ? pkg[manifestField] : undefined
	if (!manifest) return []
	const names = new Set<string>()
	if (isRecord(manifest[MANIFEST_PLUGIN_PACKAGES_FIELD])) {
		for (const name of Object.keys(manifest[MANIFEST_PLUGIN_PACKAGES_FIELD])) names.add(name)
	}
	return [...names]
}

function removeStalePeerDependencies(pkg: WorkspacePackageJson, names: string[]): string[] {
	const removed: string[] = []
	for (const name of names) {
		let changed = false
		if (pkg.peerDependencies?.[name] !== undefined) {
			delete pkg.peerDependencies[name]
			changed = true
		}
		if (pkg.peerDependenciesMeta?.[name] !== undefined) {
			delete pkg.peerDependenciesMeta[name]
			changed = true
		}
		if (changed) removed.push(name)
	}
	if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length === 0) {
		delete pkg.peerDependencies
	}
	if (pkg.peerDependenciesMeta && Object.keys(pkg.peerDependenciesMeta).length === 0) {
		delete pkg.peerDependenciesMeta
	}
	return removed.sort((a, b) => a.localeCompare(b))
}

function syncOptionalPeerMetadata(
	pkg: WorkspacePackageJson,
	facts: RuleContext['pluginUsages'],
): string[] {
	const meta = { ...pkg.peerDependenciesMeta }
	const changes: string[] = []
	for (const [name, mode] of facts) {
		const current = { ...meta[name] }
		if (mode === 'optional') {
			if (current.optional === true) continue
			current.optional = true
			meta[name] = current
			changes.push(`${name}=optional`)
			continue
		}
		if (current.optional !== true) continue
		delete current.optional
		if (Object.keys(current).length === 0) delete meta[name]
		else meta[name] = current
		changes.push(`${name}=required`)
	}
	if (changes.length === 0) return changes
	if (Object.keys(meta).length === 0) delete pkg.peerDependenciesMeta
	else pkg.peerDependenciesMeta = sortObjectRecord(meta)
	return changes.sort((a, b) => a.localeCompare(b))
}

function syncPluginPackages(
	pkg: WorkspacePackageJson,
	facts: RuleContext['pluginUsages'],
	manifestField: string,
): Record<string, 'required' | 'optional'> | undefined {
	const next = Object.fromEntries(
		[...facts.entries()].sort(([a], [b]) => a.localeCompare(b)),
	) as Record<string, 'required' | 'optional'>
	const manifest = isRecord(pkg[manifestField])
		? (pkg[manifestField] as Record<string, unknown>)
		: {}
	const previous = isRecord(manifest[MANIFEST_PLUGIN_PACKAGES_FIELD])
		? (manifest[MANIFEST_PLUGIN_PACKAGES_FIELD] as Record<string, unknown>)
		: {}
	if (recordsEqual(previous, next)) return undefined

	const updated = { ...manifest }
	if (Object.keys(next).length === 0) delete updated[MANIFEST_PLUGIN_PACKAGES_FIELD]
	else updated[MANIFEST_PLUGIN_PACKAGES_FIELD] = next
	if (Object.keys(updated).length === 0) delete pkg[manifestField]
	else pkg[manifestField] = updated
	return next
}

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
	const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every(([key, value], index) => {
			const other = rightEntries[index]
			return other?.[0] === key && other[1] === value
		})
	)
}

function sortStringRecord(record: Record<string, string>) {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function sortObjectRecord<T>(record: Record<string, T>) {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
