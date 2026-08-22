import type { PluginNodeSlot } from '../identity'
import type { PluginGraph } from '../PluginDefinitions'

type DependentScratch = {
	marks: number[]
	epoch: number
	stack: number[]
}

export class DependentClosureCollector {
	private scratch: DependentScratch = {
		marks: [],
		epoch: 0,
		stack: [],
	}

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: PluginNodeSlot,
		) => PluginNodeSlot | undefined,
	) {}

	public collect(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginNodeSlot>,
	): Set<PluginNodeSlot> {
		return this.collectWith(graph, roots, (currentGraph, slot) =>
			currentGraph.dependentSlotsOf(slot),
		)
	}

	/** Required + optional restart/ordering closure. */
	public collectOrdering(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginNodeSlot>,
	): Set<PluginNodeSlot> {
		return this.collectWith(graph, roots, (currentGraph, slot) =>
			currentGraph.orderDependentSlotsOf(slot),
		)
	}

	private collectWith(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginNodeSlot>,
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

		const { stack } = this.scratch
		this.scratch.epoch += 1
		if (this.scratch.epoch >= Number.MAX_SAFE_INTEGER) {
			this.scratch.marks = []
			this.scratch.epoch = 1
		}
		const epoch = this.scratch.epoch
		const marks = this.scratch.marks
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
			if (marks[slot] === epoch) continue
			marks[slot] = epoch
			stack.push(slot)
		}

		while (stack.length > 0) {
			const current = stack.pop()!
			const currentKey = graph.keyOf(current)
			if (currentKey !== undefined) affected.add(currentKey as PluginNodeSlot)
			const dependents = dependentsOf(graph, current)
			for (let i = 0; i < dependents.length; i++) {
				const dep = dependents[i]!
				if (!Number.isInteger(dep) || dep < 0 || dep >= graph.slotCount()) continue
				if (marks[dep] === epoch) continue
				marks[dep] = epoch
				stack.push(dep)
			}
		}

		stack.length = 0
		return affected
	}
}
