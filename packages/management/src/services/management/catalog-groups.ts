import {
	formatPluginDefinitionReference,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginCatalogSectionBasis } from '../../web/protocol'

export type PluginCatalogLayoutEntry = Readonly<{
	address: PluginNodeAddress
	displayName?: string
	provides?: PluginDefinitionAddress
	requires?: readonly PluginDefinitionAddress[]
}>

export type CatalogFamily = {
	definition: PluginDefinitionAddress
	reference: string
	name: string
	provides?: string
	requires: string[]
	nodes: PluginNodeAddress[]
}

export type CatalogGroup = {
	sectionId: string
	name: string
	basis: PluginCatalogSectionBasis
	nodes: readonly PluginNodeAddress[]
}

export function catalogFamilies(
	entries: readonly PluginCatalogLayoutEntry[],
): Map<string, CatalogFamily> {
	const families = new Map<string, CatalogFamily>()
	const seen = new Set<string>()
	for (const entry of entries) {
		const address = parsePluginNodeAddress(entry.address)
		const nodeKey = pluginNodeIndexKey(address)
		if (seen.has(nodeKey)) throw new TypeError('duplicate Plugin node')
		seen.add(nodeKey)
		const definition = address.definition
		const reference = formatPluginDefinitionReference(definition)
		const provides =
			entry.provides &&
			formatPluginDefinitionReference(parsePluginDefinitionAddress(entry.provides))
		const requires = [
			...new Set(
				(entry.requires ?? []).map((ref) =>
					formatPluginDefinitionReference(parsePluginDefinitionAddress(ref)),
				),
			),
		].sort()
		const existing = families.get(reference)
		if (existing) {
			if (
				existing.provides !== provides ||
				JSON.stringify(existing.requires) !== JSON.stringify(requires)
			) {
				throw new TypeError('inconsistent facts for one Plugin definition')
			}
			existing.nodes.push(address)
		} else {
			families.set(reference, {
				definition,
				reference,
				name: entry.displayName || definition.exportName,
				provides,
				requires,
				nodes: [address],
			})
		}
	}
	for (const family of families.values())
		family.nodes.sort((a, b) => pluginNodeIndexKey(a).localeCompare(pluginNodeIndexKey(b)))
	return families
}

/** Pure, iterative SCC condensation followed by capped root ownership propagation: O(V + E). */
export function automaticCatalogGroups(
	families: ReadonlyMap<string, CatalogFamily>,
): CatalogGroup[] {
	const refs = [...families.keys()].sort()
	const providers = new Map<string, string[]>()
	for (const family of families.values()) {
		if (!family.provides) continue
		const members = providers.get(family.provides) ?? []
		members.push(family.reference)
		providers.set(family.provides, members)
	}
	const edges = new Map<string, string[]>()
	const reverse = new Map(refs.map((ref) => [ref, [] as string[]]))
	for (const ref of refs) {
		const dependencies = new Set<string>()
		for (const required of families.get(ref)!.requires) {
			for (const target of families.has(required) ? [required] : (providers.get(required) ?? [])) {
				if (target !== ref) dependencies.add(target)
			}
		}
		edges.set(ref, [...dependencies])
		for (const target of dependencies) reverse.get(target)!.push(ref)
	}
	// Kosaraju with explicit stacks so long dependency chains cannot overflow the JS stack.
	const visited = new Set<string>()
	const finish: string[] = []
	for (const ref of refs) {
		if (visited.has(ref)) continue
		visited.add(ref)
		const stack: [string, number][] = [[ref, 0]]
		while (stack.length > 0) {
			const top = stack[stack.length - 1]!
			const next = edges.get(top[0])![top[1]++]
			if (next !== undefined) {
				if (!visited.has(next)) {
					visited.add(next)
					stack.push([next, 0])
				}
			} else {
				finish.push(top[0])
				stack.pop()
			}
		}
	}
	const component = new Map<string, number>()
	const members: string[][] = []
	for (const ref of finish.toReversed()) {
		if (component.has(ref)) continue
		const id = members.length
		const group: string[] = []
		const stack = [ref]
		component.set(ref, id)
		while (stack.length > 0) {
			const current = stack.pop()!
			group.push(current)
			for (const next of reverse.get(current)!) {
				if (!component.has(next)) {
					component.set(next, id)
					stack.push(next)
				}
			}
		}
		members.push(group.sort())
	}
	const outgoing = members.map(() => new Set<number>())
	const incoming = members.map(() => 0)
	for (const [ref, targets] of edges) {
		const from = component.get(ref)!
		for (const target of targets) {
			const to = component.get(target)!
			if (from !== to && !outgoing[from]!.has(to)) {
				outgoing[from]!.add(to)
				incoming[to]!++
			}
		}
	}
	// -1 denotes shared ownership; at most one root id is retained per component.
	const owners: (number | undefined)[] = members.map((): number | undefined => undefined)
	const queue: number[] = []
	for (let i = 0; i < members.length; i++)
		if (incoming[i] === 0) {
			owners[i] = i
			queue.push(i)
		}
	for (let index = 0; index < queue.length; index++) {
		const from = queue[index]!
		for (const to of outgoing[from]!) {
			owners[to] =
				owners[to] === undefined ? owners[from] : owners[to] === owners[from] ? owners[to] : -1
			if (--incoming[to]! === 0) queue.push(to)
		}
	}
	const groups = new Map<number, string[]>()
	for (let i = 0; i < members.length; i++) {
		const owner = owners[i]!
		const group = groups.get(owner) ?? []
		group.push(...members[i]!)
		groups.set(owner, group)
	}
	const result: CatalogGroup[] = []
	for (const [owner, group] of groups) {
		// A fork family counts once. Isolated/singleton families stay in the flat list.
		if (group.length < 2) continue
		const root = owner === -1 ? undefined : families.get(members[owner]![0]!)!
		result.push({
			sectionId: root ? `auto:${root.reference}` : 'auto:shared',
			name: root ? root.name : '共享依赖',
			basis: root ? { kind: 'dependency', definition: root.definition } : { kind: 'shared' },
			nodes: group.sort().flatMap((ref) => families.get(ref)!.nodes),
		})
	}
	return result.sort(
		(a, b) =>
			Number(a.basis.kind === 'shared') - Number(b.basis.kind === 'shared') ||
			a.name.localeCompare(b.name) ||
			a.sectionId.localeCompare(b.sectionId),
	)
}
