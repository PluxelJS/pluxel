import type { ServiceData } from '../internal-types'
import type { AliasConflictPolicy, AliasKey, Identifier } from '../types'
import type { VerificationError } from '../verifier'

export function computeAliasIndex(
	services: ReadonlyMap<Identifier<unknown>, ServiceData<unknown>>,
	aliasPolicy: AliasConflictPolicy,
): {
	aliasIndex: Map<AliasKey, Identifier<unknown>>
	errors: VerificationError[]
} {
	const aliasIndex = new Map<AliasKey, Identifier<unknown>>()
	const errors: VerificationError[] = []

	if (aliasPolicy === 'firstWins') {
		for (const [id, meta] of services) {
			const aliases = meta.aliases
			if (aliases.length === 0) continue
			for (const a of aliases) {
				if (!aliasIndex.has(a)) aliasIndex.set(a, id)
			}
		}
		return { aliasIndex, errors }
	}

	if (aliasPolicy === 'lastWins') {
		for (const [id, meta] of services) {
			const aliases = meta.aliases
			if (aliases.length === 0) continue
			for (const a of aliases) {
				aliasIndex.set(a, id)
			}
		}
		return { aliasIndex, errors }
	}

	// aliasPolicy === 'error'
	const seen = new Map<AliasKey, Identifier<unknown>>()
	const conflicts = new Map<AliasKey, Identifier<unknown>[]>()

	for (const [id, meta] of services) {
		const aliases = meta.aliases
		if (aliases.length === 0) continue
		for (const a of aliases) {
			const prev = seen.get(a)
			if (prev === undefined) {
				seen.set(a, id)
			} else if (prev !== id) {
				const existed = conflicts.get(a)
				if (existed) existed.push(id)
				else conflicts.set(a, [prev, id])
			}
		}
	}

	for (const [a, id] of seen) aliasIndex.set(a, id)
	if (conflicts.size > 0) {
		for (const [alias, ids] of conflicts) {
			errors.push({ kind: 'AliasConflict', alias, ids })
		}
	}
	return { aliasIndex, errors }
}

export function computeAliasIndexErrorIncremental(
	prevAliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	prevServices: ReadonlyMap<Identifier<unknown>, ServiceData<unknown>>,
	nextServices: ReadonlyMap<Identifier<unknown>, ServiceData<unknown>>,
	dirty: ReadonlySet<Identifier<unknown>>,
): {
	aliasIndex: Map<AliasKey, Identifier<unknown>>
	errors: VerificationError[]
} {
	const aliasIndex = new Map(prevAliasIndex)
	const errors: VerificationError[] = []
	const conflicts = new Map<AliasKey, Identifier<unknown>[]>()

	// 1) 删除 dirty 节点旧 aliases
	for (const id of dirty) {
		const oldMeta = prevServices.get(id)
		const aliases = oldMeta?.aliases
		if (!aliases || aliases.length === 0) continue
		for (const a of aliases) {
			if (aliasIndex.get(a) === id) aliasIndex.delete(a)
		}
	}

	// 2) 添加 dirty 节点新 aliases
	for (const id of dirty) {
		const nextMeta = nextServices.get(id)
		const aliases = nextMeta?.aliases
		if (!aliases || aliases.length === 0) continue
		for (const a of aliases) {
			const prev = aliasIndex.get(a)
			if (prev === undefined || prev === id) {
				aliasIndex.set(a, id)
				continue
			}
			const existed = conflicts.get(a)
			if (existed) existed.push(id)
			else conflicts.set(a, [prev, id])
		}
	}

	if (conflicts.size > 0) {
		for (const [alias, ids] of conflicts) {
			errors.push({ kind: 'AliasConflict', alias, ids })
		}
	}
	return { aliasIndex, errors }
}
