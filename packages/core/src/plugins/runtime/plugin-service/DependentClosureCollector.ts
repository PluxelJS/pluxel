import type { PluginIdentifier } from '../../types'
import type { PluginNodeSlot } from '../identity'
import type { PluginGraph } from '../PluginDefinitions'

type DependentScratch = {
	marks: Uint8Array
	markedSlots: number[]
	stack: number[]
}

export class DependentClosureCollector {
	private scratch: DependentScratch = {
		marks: new Uint8Array(0),
		markedSlots: [],
		stack: [],
	}

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: PluginIdentifier | PluginNodeSlot,
		) => PluginNodeSlot | undefined,
	) {}

	public collect(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginIdentifier | PluginNodeSlot>,
	): Set<PluginNodeSlot> {
		return this.collectWith(graph, roots, (currentGraph, slot) =>
			currentGraph.dependentSlotsOf(slot),
		)
	}

	/** Required + optional restart/ordering closure. */
	public collectOrdering(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginIdentifier | PluginNodeSlot>,
	): Set<PluginNodeSlot> {
		return this.collectWith(graph, roots, (currentGraph, slot) =>
			currentGraph.orderDependentSlotsOf(slot),
		)
	}

	private collectWith(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginIdentifier | PluginNodeSlot>,
		dependentsOf: (graph: PluginGraph, slot: number) => readonly number[],
	): Set<PluginNodeSlot> {
		if (!graph) {
			const out = new Set<PluginNodeSlot>()
			for (const root of roots) {
				const key = this.resolveGraphKey(undefined, root)
				if (key) out.add(key)
			}
			return out
		}

		if (this.scratch.marks.length < graph.slotCount()) {
			this.scratch = {
				marks: new Uint8Array(graph.slotCount()),
				markedSlots: [],
				stack: [],
			}
		}

		const { marks, markedSlots, stack } = this.scratch
		markedSlots.length = 0
		stack.length = 0
		const affected = new Set<PluginNodeSlot>()
		for (const root of roots) {
			const canonical = this.resolveGraphKey(graph, root)
			if (!canonical) continue
			const slot = graph.slotOf(canonical)
			if (slot === undefined) {
				affected.add(canonical)
				continue
			}
			if (marks[slot] === 1) continue
			marks[slot] = 1
			markedSlots.push(slot)
			stack.push(slot)
		}

		while (stack.length > 0) {
			const current = stack.pop()!
			const currentKey = graph.keyOf(current)
			if (currentKey !== undefined) affected.add(currentKey as PluginNodeSlot)
			const dependents = dependentsOf(graph, current)
			for (let i = 0; i < dependents.length; i++) {
				const dep = dependents[i]!
				if (!Number.isInteger(dep) || dep < 0 || dep >= marks.length) continue
				if (marks[dep] === 1) continue
				marks[dep] = 1
				markedSlots.push(dep)
				stack.push(dep)
			}
		}

		for (let i = 0; i < markedSlots.length; i++) marks[markedSlots[i]!] = 0
		markedSlots.length = 0
		stack.length = 0
		return affected
	}
}
