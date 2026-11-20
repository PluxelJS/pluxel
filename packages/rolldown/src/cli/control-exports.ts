import type { WorkspacePackageJson } from '../workspace/package-json'

/** Generated address providers use the consuming application's shared Host runtime. */
export function assertControlHostPeer(pkg: WorkspacePackageJson, packageJsonPath: string): void {
	const name = '@pluxel/host'
	const failures: string[] = []
	const peer = pkg.peerDependencies?.[name]
	if (typeof peer !== 'string' || !peer.trim())
		failures.push(
			`peerDependencies.${name}: expected a declared Host peer, actual ${String(peer ?? '<missing>')}`,
		)
	for (const field of ['dependencies', 'optionalDependencies'] as const) {
		const value = pkg[field]?.[name]
		if (value !== undefined)
			failures.push(
				`${field}.${name}: expected absent for the shared Host runtime, actual ${value}`,
			)
	}
	if (failures.length > 0)
		throw new Error(
			`[pluxel:build] Invalid generated control dependency declarations in ${packageJsonPath}:\n${failures.join('\n')}\nDeclare @pluxel/host as an author-maintained peer; mark it optional only when non-control runtime entrypoints do not require Host. Then rerun pluxel build.`,
		)
}

export const controlEntry = (directory: string) => ({
	types: `${directory}/index.d.mts`,
	import: `${directory}/index.mjs`,
	default: `${directory}/index.mjs`,
})

/** Own the marked generated subpath, while preserving author root conditions and exports. */
export function addControlExport(
	value: unknown,
	entry: ReturnType<typeof controlEntry>,
	marker: unknown,
	field: string,
): Record<string, unknown> {
	const subpaths =
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).some((key) => key.startsWith('.'))
	const exports: Record<string, unknown> =
		value === undefined ? {} : subpaths ? { ...(value as Record<string, unknown>) } : { '.': value }
	const existing = exports['./control']
	if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
		const previousDirectory =
			typeof marker === 'string' && marker.endsWith('/manifest.json')
				? marker.slice(0, -'/manifest.json'.length)
				: undefined
		if (
			!previousDirectory ||
			JSON.stringify(existing) !== JSON.stringify(controlEntry(previousDirectory))
		)
			throw new Error(
				`${field}['./control'] belongs to the author; choose another export before enabling generated Plugin control materials`,
			)
	}
	if (marker !== undefined && (typeof marker !== 'string' || !marker.endsWith('/manifest.json')))
		throw new Error('pluxel.control must name the generated control/manifest.json')
	return { ...exports, './control': entry }
}
