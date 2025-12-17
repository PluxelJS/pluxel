import type { PackageJson } from 'pkg-types'
import { MANIFEST_DEPEND_ON_FIELD } from '../../env'
import type { RuleContext } from '../types'

export async function pluginDependencyRule(pkg: PackageJson, context: RuleContext) {
	if (context.pluginUsages.size === 0) return undefined

	const runtimeDependencies = new Set(Object.keys(pkg.dependencies ?? {}))
	const versions = resolvePluginVersions(pkg, context)
	const messages: string[] = []

	const peerChanges = ensurePeerDependencies(pkg, versions)
	if (peerChanges.length > 0) {
		messages.push(`peerDependencies set ${peerChanges.join(', ')}`)
	}

	const dependencyRemovals = removeEntries(pkg, 'dependencies', versions)
	if (dependencyRemovals.length > 0) {
		messages.push(`dependencies - ${dependencyRemovals.join(', ')}`)
	}

	const devDependencyRemovals = removeEntries(pkg, 'devDependencies', versions)
	if (devDependencyRemovals.length > 0) {
		messages.push(`devDependencies - ${devDependencyRemovals.join(', ')}`)
	}

	const manifestUpdate = syncManifestDependOn(
		pkg,
		context.pluginUsages,
		runtimeDependencies,
		context.manifestField,
		MANIFEST_DEPEND_ON_FIELD,
	)
	if (manifestUpdate) {
		const { required, optional } = manifestUpdate
		messages.push(
			`${context.manifestField}.${MANIFEST_DEPEND_ON_FIELD} updated (required=[${required.join(', ')}], optional=[${optional.join(', ')}])`,
		)
	}

	return messages.length > 0 ? messages : undefined
}

function resolvePluginVersions(pkg: PackageJson, context: RuleContext) {
	const versions = new Map<string, string>()
	for (const name of context.pluginUsages.keys()) {
		const version =
			pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name] ?? '*'
		versions.set(name, version)
	}
	return versions
}

function ensurePeerDependencies(pkg: PackageJson, versions: Map<string, string>) {
	const peers = { ...(pkg.peerDependencies ?? {}) }
	const updates: string[] = []
	let mutated = false

	for (const [name, version] of versions) {
		if (peers[name] === version) continue
		peers[name] = version
		updates.push(`${name}@${version}`)
		mutated = true
	}

	if (!mutated) return updates
	pkg.peerDependencies = sortRecord(peers)
	updates.sort((a, b) => a.localeCompare(b))
	return updates
}

function removeEntries(
	pkg: PackageJson,
	section: 'dependencies' | 'devDependencies',
	versions: Map<string, string>,
) {
	const source = pkg[section]
	if (!source) return []

	const removed: string[] = []
	for (const name of versions.keys()) {
		if (!(name in source)) continue
		delete source[name]
		removed.push(name)
	}

	if (removed.length === 0) return removed

	if (Object.keys(source).length === 0) {
		delete pkg[section]
	}

	removed.sort((a, b) => a.localeCompare(b))
	return removed
}

function syncManifestDependOn(
	pkg: PackageJson,
	pluginUsages: Map<string, { hasStaticImport: boolean; hasDynamicImport: boolean }>,
	runtimeDependencies: Set<string>,
	manifestField: string,
	dependOnField: string,
) {
	const required: string[] = []
	const optional: string[] = []

	for (const [name, usage] of pluginUsages) {
		if (!usage.hasStaticImport && !usage.hasDynamicImport) continue

		// 只有在项目声明了运行时依赖并且是静态引入时，才视为必需插件；
		// 其余情况（动态引入、仅开发依赖等）都被视为可选。
		const declaredInDependencies = runtimeDependencies.has(name)

		if (usage.hasStaticImport && declaredInDependencies) {
			required.push(name)
			continue
		}

		optional.push(name)
	}

	required.sort((a, b) => a.localeCompare(b))
	optional.sort((a, b) => a.localeCompare(b))

	const currentManifest = isRecord(pkg[manifestField])
		? (pkg[manifestField] as Record<string, unknown>)
		: {}
	const dependOn = isRecord(currentManifest[dependOnField])
		? (currentManifest[dependOnField] as Record<string, unknown>)
		: {}
	const prevRequired = Array.isArray(dependOn.required)
		? [...dependOn.required].sort(sortStrings)
		: []
	const prevOptional = Array.isArray(dependOn.optional)
		? [...dependOn.optional].sort(sortStrings)
		: []

	if (arraysEqual(required, prevRequired) && arraysEqual(optional, prevOptional)) {
		return undefined
	}

	const nextManifest = {
		...currentManifest,
		[dependOnField]: {
			...dependOn,
			required,
			optional,
		},
	}

	pkg[manifestField] = nextManifest as any
	return { required, optional }
}

function arraysEqual(left: string[], right: string[]) {
	if (left.length !== right.length) return false
	return left.every((value, index) => value === right[index])
}

function sortStrings(a: string, b: string) {
	return a.localeCompare(b)
}

function sortRecord(record: Record<string, string>) {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
