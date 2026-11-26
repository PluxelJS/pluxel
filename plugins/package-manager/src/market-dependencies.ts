import { rcompare, satisfies, validRange } from 'semver'
import {
	packageMutationLimit,
	type ManagedPackage,
	type MarketInstallRequest,
	type MarketRelease,
} from './contracts.ts'
import type { PackageMarketClient } from './market.ts'

export type CheckedPlugin = MarketInstallRequest &
	Pick<MarketRelease, 'integrity' | 'peerDependencies' | 'pluginPackages'>
type Requirement = { parent: CheckedPlugin; range: string }
type Selected = Map<string, CheckedPlugin>
type Resolution =
	| { ok: true; selected: Selected; requirements: Map<string, Requirement[]> }
	| { ok: false; name: string; message: string }

// Prefer the highest compatible checked release. Backtrack if its transitive peers conflict.
// Explicit selections and existing managed packages have fixed versions throughout the search.
export async function resolvePluginDependencies(
	roots: Selected,
	market: Pick<PackageMarketClient, 'release' | 'releases'>,
	installed: readonly ManagedPackage[],
): Promise<Resolution> {
	const versions = new Map<string, string[]>()
	const releases = new Map<string, CheckedPlugin>()
	let attempts = 0

	async function candidates(name: string, parent: CheckedPlugin) {
		const key = JSON.stringify([parent.marketId, parent.registry, name])
		const cached = versions.get(key)
		if (cached) return cached
		const values = new Set<string>()
		const cursors = new Set<string>()
		let cursor: string | undefined
		do {
			const page = await market.releases(parent.marketId, name, {
				registry: parent.registry,
				limit: 50,
				cursor,
			})
			if (page.ok === false && page.error.code === 'NOT_INDEXED' && !cursor) break
			if (page.ok === false)
				throw new Error(`${name}, required by ${parent.name}: ${page.error.message}`)
			for (const release of page.value.releases) values.add(release.version)
			cursor = page.value.nextCursor ?? undefined
			if (cursor) {
				if (cursors.has(cursor) || cursors.size >= 99)
					throw new Error(
						`Cannot finish browsing checked versions of ${name}. Select an exact version explicitly.`,
					)
				cursors.add(cursor)
			}
		} while (cursor)
		const sorted = [...values].sort(rcompare)
		versions.set(key, sorted)
		return sorted
	}

	async function solve(selected: Selected): Promise<Resolution> {
		const requirements = new Map<string, Requirement[]>()
		for (const parent of selected.values()) {
			for (const [name, mode] of Object.entries(parent.pluginPackages)) {
				if (mode !== 'required') continue
				const range = parent.peerDependencies[name]
				if (!range || !validRange(range))
					return {
						ok: false,
						name,
						message: `${parent.name}@${parent.version} declares an invalid required plugin range for ${name}.`,
					}
				const peers = requirements.get(name) ?? []
				peers.push({ parent, range })
				requirements.set(name, peers)
			}
		}
		if (new Set([...selected.keys(), ...requirements.keys()]).size > packageMutationLimit)
			return {
				ok: false,
				name: '',
				message: `The required plugin graph exceeds ${packageMutationLimit} managed packages.`,
			}

		for (const [name, peers] of requirements) {
			const chosen = selected.get(name)
			const source = peers[0]!.parent
			if (
				!roots.has(name) &&
				peers.some(
					({ parent }) =>
						parent.registry !== source.registry || parent.marketId !== source.marketId,
				)
			)
				return {
					ok: false,
					name,
					message: `Different sources require ${name}. Select its registry and exact version explicitly.`,
				}
			if (chosen && peers.some(({ range }) => !satisfies(chosen.version, range)))
				return {
					ok: false,
					name,
					message: `${name}@${chosen.version} does not satisfy ${describe(peers)}.`,
				}
		}
		const next = [...requirements].find(([name]) => !selected.has(name))
		if (!next) return { ok: true, selected, requirements }
		const [name, peers] = next
		const parent = peers[0]!.parent
		const current = installed.find((pkg) => pkg.name === name)
		if (
			current &&
			(current.marketRegistry !== parent.registry ||
				!current.installedVersion ||
				!peers.every(({ range }) => satisfies(current.installedVersion!, range)))
		)
			return {
				ok: false,
				name,
				message: `The managed copy of ${name} cannot satisfy ${describe(peers)} with its current version and source. Select its replacement explicitly.`,
			}
		const available = current?.installedVersion
			? [current.installedVersion]
			: await candidates(name, parent)
		let conflict: Resolution = {
			ok: false,
			name,
			message: `No checked version of ${name} at ${parent.registry} satisfies ${describe(peers)}. Select a compatible release explicitly if it comes from another source.`,
		}
		for (const version of available) {
			if (!peers.every(({ range }) => satisfies(version, range))) continue
			if (++attempts > 400)
				throw new Error(
					'Plugin dependency resolution exceeded its search limit. Select exact dependency versions to narrow the plan.',
				)
			const key = JSON.stringify([parent.marketId, parent.registry, name, version])
			let release = releases.get(key)
			if (!release) {
				const read = await market.release(parent.marketId, name, version, parent.registry)
				if (read.ok === false && read.error.code === 'NOT_INDEXED') continue
				if (read.ok === false)
					throw new Error(`${name}@${version}, required by ${parent.name}: ${read.error.message}`)
				const { integrity, pluginPackages, peerDependencies } = read.value
				release = {
					name,
					version,
					registry: parent.registry,
					marketId: parent.marketId,
					integrity,
					pluginPackages,
					peerDependencies,
				}
				releases.set(key, release)
			}
			const branch = await solve(new Map(selected).set(name, release))
			if (branch.ok) return branch
			conflict = branch
		}
		return conflict
	}

	return solve(roots)
}

function describe(peers: Requirement[]) {
	return peers
		.map(({ parent, range }) => `${range} (required by ${parent.name}@${parent.version})`)
		.join(', ')
}
