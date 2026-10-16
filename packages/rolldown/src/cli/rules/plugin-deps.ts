import type { WorkspacePackageJson } from '../../workspace/package-json'
import type { RuleContext } from './types'

/** Build validates author-owned dependency roles and updates only compiled publication facts. */
export function pluginDependencyRule(pkg: WorkspacePackageJson, context: RuleContext) {
	validatePluginDependencies(pkg, context)
	const manifestUpdate = syncPluginPackages(pkg, context.pluginUsages)
	return manifestUpdate
		? [
				`pluxel.pluginPackages updated (${Object.entries(manifestUpdate)
					.map(([name, mode]) => `${name}=${mode}`)
					.join(', ')})`,
			]
		: undefined
}

function validatePluginDependencies(pkg: WorkspacePackageJson, context: RuleContext): void {
	const failures: string[] = []
	for (const [name, mode] of context.pluginUsages) {
		const peer = pkg.peerDependencies?.[name]
		if (typeof peer !== 'string' || !peer.trim()) {
			failures.push(
				`peerDependencies.${name}: expected a declared Plugin peer, actual ${String(peer ?? '<missing>')}`,
			)
		}
		for (const field of ['dependencies', 'optionalDependencies'] as const) {
			const value = pkg[field]?.[name]
			if (value !== undefined)
				failures.push(
					`${field}.${name}: expected absent for a shared Plugin dependency, actual ${value}`,
				)
		}
		const optional = pkg.peerDependenciesMeta?.[name]?.optional === true
		if (optional !== (mode === 'optional')) {
			failures.push(
				`peerDependenciesMeta.${name}.optional: expected ${mode === 'optional'}, actual ${optional}`,
			)
		}
	}
	if (failures.length > 0)
		throw new Error(
			`[pluxel:build] Invalid Plugin dependency declarations in ${context.packageJsonPath}:\n${failures.join('\n')}\nEdit the author-maintained package.json fields, then rerun pluxel build.`,
		)
}

function syncPluginPackages(
	pkg: WorkspacePackageJson,
	facts: RuleContext['pluginUsages'],
): Record<string, 'required' | 'optional'> | undefined {
	const next = Object.fromEntries(
		[...facts.entries()].sort(([a], [b]) => a.localeCompare(b)),
	) as Record<string, 'required' | 'optional'>
	const manifest = isRecord(pkg.pluxel) ? (pkg.pluxel as Record<string, unknown>) : {}
	const previous = isRecord(manifest.pluginPackages)
		? (manifest.pluginPackages as Record<string, unknown>)
		: {}
	if (recordsEqual(previous, next)) return undefined

	const updated = { ...manifest }
	if (Object.keys(next).length === 0) delete updated.pluginPackages
	else updated.pluginPackages = next
	if (Object.keys(updated).length === 0) delete pkg.pluxel
	else pkg.pluxel = updated
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
