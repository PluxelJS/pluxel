export type LocalPackageDependency = Readonly<{
	name: string
	range: string
	kind: 'dependency' | 'optional' | 'peer' | 'optional peer'
	plugin?: 'required' | 'optional'
}>
export type PackageDocument = Readonly<{
	name: string
	version: string | null
	description: string | null
	license: string | null
	readme: Readonly<{ text: string; truncated: boolean }> | null
	dependencies: readonly LocalPackageDependency[]
}>

const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

export function isPackageName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 214 && packageName.test(value)
}

export type Manifest = Record<string, unknown>
export const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

export function dependencies(manifest: Manifest): LocalPackageDependency[] {
	const items = new Map<string, LocalPackageDependency>()
	const plugins =
		record(manifest.pluxel) && record(manifest.pluxel.pluginPackages)
			? manifest.pluxel.pluginPackages
			: {}
	const peerMeta = record(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {}
	for (const [field, kind] of [
		['dependencies', 'dependency'],
		['optionalDependencies', 'optional'],
		['peerDependencies', 'peer'],
	] as const) {
		const entries = manifest[field]
		if (!record(entries)) continue
		for (const [name, range] of Object.entries(entries)) {
			if (!isPackageName(name) || typeof range !== 'string') continue
			const peer = peerMeta[name]
			const mode = plugins[name]
			items.set(name, {
				name,
				range,
				kind: kind === 'peer' && record(peer) && peer.optional === true ? 'optional peer' : kind,
				...(kind === 'peer' && (mode === 'optional' || mode === 'required') && { plugin: mode }),
			})
		}
	}
	return [...items.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function packageDocument(
	name: string,
	manifest: Manifest,
	readme: PackageDocument['readme'],
): PackageDocument {
	return {
		name,
		version: typeof manifest.version === 'string' ? manifest.version : null,
		description: typeof manifest.description === 'string' ? manifest.description : null,
		license: typeof manifest.license === 'string' ? manifest.license : null,
		dependencies: dependencies(manifest),
		readme,
	}
}
