import type { ServiceData } from '../internal-types'
import type { AliasKey, Identifier } from '../types'

export function resolveDependencyToken(
	services: ReadonlyMap<Identifier<unknown>, ServiceData<unknown>>,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	dep: Identifier<unknown>,
): Identifier<unknown> {
	if (services.has(dep)) return dep
	return aliasIndex.get(dep as unknown as AliasKey) ?? dep
}

export function computeAffectedDependents(
	dirty: ReadonlySet<Identifier<unknown>>,
	prevDependents: ReadonlyMap<Identifier<unknown>, Set<Identifier<unknown>>>,
): Set<Identifier<unknown>> {
	const affected = new Set<Identifier<unknown>>()
	const stack: Identifier<unknown>[] = []
	for (const id of dirty) stack.push(id)

	while (stack.length) {
		const id = stack.pop()
		if (!id) continue
		if (affected.has(id)) continue
		affected.add(id)
		const deps = prevDependents.get(id)
		if (!deps) continue
		for (const d of deps) stack.push(d)
	}
	return affected
}

export function applyDependentsDelta(
	prevDependents: ReadonlyMap<Identifier<unknown>, Set<Identifier<unknown>>>,
	prevServices: ReadonlyMap<Identifier<unknown>, ServiceData<unknown>>,
	prevAliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	nextServices: ReadonlyMap<Identifier<unknown>, ServiceData<unknown>>,
	nextAliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	affected: ReadonlySet<Identifier<unknown>>,
): Map<Identifier<unknown>, Set<Identifier<unknown>>> {
	const next = new Map<Identifier<unknown>, Set<Identifier<unknown>>>(
		prevDependents,
	)
	const touched = new Set<Identifier<unknown>>()

	const getWritable = (key: Identifier<unknown>): Set<Identifier<unknown>> => {
		const existed = next.get(key)
		if (!existed) {
			const created = new Set<Identifier<unknown>>()
			next.set(key, created)
			touched.add(key)
			return created
		}
		if (touched.has(key)) return existed
		const cloned = new Set(existed)
		next.set(key, cloned)
		touched.add(key)
		return cloned
	}

	const removeEdge = (
		dep: Identifier<unknown>,
		dependent: Identifier<unknown>,
	): void => {
		const set = next.get(dep)
		if (!set) return
		const writable = touched.has(dep) ? set : new Set(set)
		writable.delete(dependent)
		if (writable.size === 0) next.delete(dep)
		else next.set(dep, writable)
		touched.add(dep)
	}

	const addEdge = (
		dep: Identifier<unknown>,
		dependent: Identifier<unknown>,
	): void => {
		const set = getWritable(dep)
		set.add(dependent)
	}

	for (const id of affected) {
		const oldMeta = prevServices.get(id)
		if (oldMeta) {
			for (const depToken of oldMeta.dependencies) {
				const resolved = resolveDependencyToken(
					prevServices,
					prevAliasIndex,
					depToken,
				)
				removeEdge(resolved, id)
			}
		}
		// 被删除的节点：移除其 key（成功 build 时应无其他引用）
		if (!nextServices.has(id)) next.delete(id)

		const newMeta = nextServices.get(id)
		if (newMeta) {
			for (const depToken of newMeta.dependencies) {
				const resolved = resolveDependencyToken(
					nextServices,
					nextAliasIndex,
					depToken,
				)
				addEdge(resolved, id)
			}
		}
	}

	return next
}
