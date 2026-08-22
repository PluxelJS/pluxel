import { GraphBuildError, type GraphBuildIssue } from './errors'
import { InstanceStore } from './InstanceStore'
import { err, ok, type Result } from './result'

export type Token = string | symbol | object | Function
export type NodeKey = string | symbol | object | Function
export type CachePolicy = 'retain' | 'fresh'

export type ClassProvider<T> = {
	kind: 'class'
	value: new (...args: any[]) => T
}

export type FactoryProvider<T> = {
	kind: 'factory'
	value: (...deps: readonly unknown[]) => T
}

export type ValueProvider<T> = {
	kind: 'value'
	value: T
}

export type ProviderCreate<T> = ClassProvider<T> | FactoryProvider<T> | ValueProvider<T>

export type ProviderDecl<T = unknown, M = unknown> = {
	key: NodeKey
	tokens?: readonly Token[]
	deps?: readonly Token[]
	/** Soft ordering/restart edges. Missing providers do not fail graph verification or DI activation. */
	optionalDeps?: readonly Token[]
	cache?: CachePolicy
	meta?: M
	create: ProviderCreate<T>
}

type NormalizedProviderDecl<T = unknown, M = unknown> = {
	key: NodeKey
	explicitTokens: readonly Token[]
	tokens: readonly Token[]
	deps: readonly Token[]
	optionalDeps: readonly Token[]
	cache: CachePolicy
	meta: M | undefined
	create: ProviderCreate<T>
}

export type GraphDeclaration<M = unknown> = {
	key: NodeKey
	tokens: readonly Token[]
	depTokens: readonly Token[]
	optionalDepTokens: readonly Token[]
	cache: CachePolicy
	meta: M | undefined
	providerKind: ProviderCreate<unknown>['kind']
}

export type GraphNode<M = unknown> = GraphDeclaration<M>

export type GraphReplacement = {
	from: NodeKey
	to: NodeKey
}

export type GraphDelta = {
	added: readonly NodeKey[]
	removed: readonly NodeKey[]
	replaced: readonly GraphReplacement[]
	affected: readonly NodeKey[]
	retargetedTokens: readonly {
		token: Token
		from?: NodeKey
		to?: NodeKey
	}[]
}

export type GraphBuild<M = unknown> = {
	graph: GraphSnapshot<M>
	delta: GraphDelta
	instances: InstanceStore<NodeKey, unknown>
	runtime: Runtime<M>
	commit(): GraphSnapshot<M>
	reset(): void
}

type Activator = (runtime: Runtime<any>) => unknown
type Slot = number
type TokenOwnerLookup = Pick<ReadonlyMap<Token, Slot>, 'get'>
type MutableTokenOwnerLookup = TokenOwnerLookup & {
	set(token: Token, slot: Slot): void
	delete(token: Token): void
}
class SlotMarks {
	private values: number[] = []
	private epoch = 1

	has(slot: Slot): boolean {
		return this.values[slot] === this.epoch
	}

	add(slot: Slot): void {
		this.values[slot] = this.epoch
	}

	clear(): void {
		this.epoch += 1
		if (this.epoch < Number.MAX_SAFE_INTEGER) return
		this.values = []
		this.epoch = 1
	}
}

class SlotColors {
	private readonly values: number[] = []

	get(slot: Slot): number {
		return this.values[slot] ?? 0
	}

	set(slot: Slot, color: number): void {
		this.values[slot] = color
	}

	has(slot: Slot): boolean {
		return this.values[slot] !== undefined
	}
}

type BuildScratch = {
	dirtyMarks: SlotMarks
	affectedMarks: SlotMarks
	changedDependentMarks: SlotMarks
	changedOptionalDependentMarks: SlotMarks
	dirtySlots: Slot[]
	affectedSlots: Slot[]
	affectedStack: Slot[]
	changedDependentSlots: Slot[]
	changedOptionalDependentSlots: Slot[]
}
type DraftState<M = unknown> = {
	base: SlotTable<NormalizedProviderDecl<unknown, M>>
	changes: Map<Slot, NormalizedProviderDecl<unknown, M> | undefined>
	slotLimit: number
	activeCount: number
	replacementSources: Slot[]
	replacementPairs: Map<Slot, Slot>
}
type PreviewCache<M = unknown> = {
	builtAtVersion: number
	builtState: DraftState<M>
	result: Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError>
}
type PlanningCache<M = unknown> = {
	builtAtVersion: number
	builtState: DraftState<M>
	providerSlotsByToken: ReadonlyMap<Token, readonly Slot[]>
	consumerSlotsByToken: ReadonlyMap<Token, readonly Slot[]>
}

const emptyArray: readonly unknown[] = []
const emptySlotArray: readonly Slot[] = []
const deletedTokenOwner = Symbol('deleted-token-owner')
const tokenOwnerCompactionMinChanges = 64
const deletedMapValue = Symbol('deleted-map-value')
const slotTableBits = 6
const slotTableBranch = 1 << slotTableBits
const slotTableMask = slotTableBranch - 1
const slotTableMaxLength = slotTableBranch ** 4

type SlotTableLeaf<T> = Array<T | undefined>
type SlotTableLevel1<T> = Array<SlotTableLeaf<T> | undefined>
type SlotTableLevel2<T> = Array<SlotTableLevel1<T> | undefined>
type SlotTableRoot<T> = Array<SlotTableLevel2<T> | undefined>

/**
 * Immutable, fixed-depth radix table specialized for dense numeric graph slots.
 *
 * Reads take four bounded array lookups. A batch update clones only the at-most-64-entry nodes
 * on paths that contain changed slots; its work is independent of the total graph size.
 */
export class SlotTable<T> implements Iterable<T | undefined> {
	constructor(
		private readonly root: SlotTableRoot<T>,
		public readonly length: number,
	) {}

	static empty<T>(): SlotTable<T> {
		return new SlotTable<T>([], 0)
	}

	static fromArray<T>(values: readonly (T | undefined)[]): SlotTable<T> {
		const builder = SlotTable.empty<T>().mutate()
		for (let slot = 0; slot < values.length; slot++) {
			const value = values[slot]
			if (value !== undefined) builder.set(slot, value)
		}
		return builder.finish(values.length)
	}

	get(slot: Slot): T | undefined {
		if (!Number.isInteger(slot) || slot < 0 || slot >= this.length) return undefined
		const rootIndex = slot >>> (slotTableBits * 3)
		const level2Index = (slot >>> (slotTableBits * 2)) & slotTableMask
		const level1Index = (slot >>> slotTableBits) & slotTableMask
		return this.root[rootIndex]?.[level2Index]?.[level1Index]?.[slot & slotTableMask]
	}

	mutate(): SlotTableBuilder<T> {
		return new SlotTableBuilder(this, this.root)
	}

	/** @internal Cost-model probe: identity of the immutable 64-slot leaf containing one slot. */
	pageIdentity(slot: Slot): object | undefined {
		if (!Number.isInteger(slot) || slot < 0 || slot >= this.length) return undefined
		const rootIndex = slot >>> (slotTableBits * 3)
		const level2Index = (slot >>> (slotTableBits * 2)) & slotTableMask
		const level1Index = (slot >>> slotTableBits) & slotTableMask
		return this.root[rootIndex]?.[level2Index]?.[level1Index]
	}

	*[Symbol.iterator](): IterableIterator<T | undefined> {
		for (let slot = 0; slot < this.length; slot++) yield this.get(slot)
	}
}

export class SlotTableBuilder<T> {
	private readonly root: SlotTableRoot<T>
	private readonly mutableLevel2 = new Map<number, SlotTableLevel2<T>>()
	private readonly mutableLevel1 = new Map<number, SlotTableLevel1<T>>()
	private readonly mutableLeaves = new Map<number, SlotTableLeaf<T>>()
	private changed = false
	private highestChangedSlot = -1

	constructor(
		private readonly base: SlotTable<T>,
		root: SlotTableRoot<T>,
	) {
		this.root = root.slice()
	}

	get(slot: Slot): T | undefined {
		if (!Number.isInteger(slot) || slot < 0 || slot >= slotTableMaxLength) return undefined
		const rootIndex = slot >>> (slotTableBits * 3)
		const level2Index = (slot >>> (slotTableBits * 2)) & slotTableMask
		const level1Index = (slot >>> slotTableBits) & slotTableMask
		return this.root[rootIndex]?.[level2Index]?.[level1Index]?.[slot & slotTableMask]
	}

	set(slot: Slot, value: T | undefined): void {
		if (!Number.isInteger(slot) || slot < 0 || slot >= slotTableMaxLength) {
			throw new RangeError(`Graph slot must be between 0 and ${slotTableMaxLength - 1}`)
		}
		if (this.get(slot) === value) return
		const rootIndex = slot >>> (slotTableBits * 3)
		const level2Index = (slot >>> (slotTableBits * 2)) & slotTableMask
		const level1Index = (slot >>> slotTableBits) & slotTableMask
		const pageIndex = slot >>> slotTableBits
		let level2 = this.mutableLevel2.get(rootIndex)
		if (!level2) {
			level2 = [...(this.root[rootIndex] ?? [])]
			this.mutableLevel2.set(rootIndex, level2)
			this.root[rootIndex] = level2
		}
		const level1Path = (rootIndex << slotTableBits) | level2Index
		let level1 = this.mutableLevel1.get(level1Path)
		if (!level1) {
			level1 = [...(level2[level2Index] ?? [])]
			this.mutableLevel1.set(level1Path, level1)
			level2[level2Index] = level1
		}
		let leaf = this.mutableLeaves.get(pageIndex)
		if (!leaf) {
			leaf = [...(level1[level1Index] ?? [])]
			this.mutableLeaves.set(pageIndex, leaf)
			level1[level1Index] = leaf
		}
		leaf[slot & slotTableMask] = value
		this.changed = true
		this.highestChangedSlot = Math.max(this.highestChangedSlot, slot)
	}

	finish(length?: number): SlotTable<T> {
		const resolvedLength = length ?? Math.max(this.base.length, this.highestChangedSlot + 1)
		if (
			!Number.isInteger(resolvedLength) ||
			resolvedLength < 0 ||
			resolvedLength > slotTableMaxLength
		) {
			throw new RangeError(`Graph slot table length must be between 0 and ${slotTableMaxLength}`)
		}
		if (!this.changed && resolvedLength === this.base.length) return this.base
		return new SlotTable(this.root, resolvedLength)
	}
}

/** Append-only key interning keeps graph slot identity stable for the lifetime of one DraftGraph. */
class NodeKeySlotRegistry {
	private readonly slotByKey = new Map<NodeKey, Slot>()
	private readonly keyBySlot: NodeKey[] = []

	intern(key: NodeKey): Slot {
		const current = this.slotByKey.get(key)
		if (current !== undefined) return current
		const slot = this.keyBySlot.length
		if (slot >= slotTableMaxLength) throw new RangeError('Graph slot limit exceeded')
		this.slotByKey.set(key, slot)
		this.keyBySlot.push(key)
		return slot
	}

	lookup(key: NodeKey): Slot | undefined {
		return this.slotByKey.get(key)
	}

	keyAt(slot: Slot): NodeKey | undefined {
		return this.keyBySlot[slot]
	}
}

/**
 * Immutable base plus a bounded change set. Incremental graph edits copy only changed token
 * owners; the change set is flattened before lookup or iteration depth can grow.
 */
class TokenOwnerIndex implements ReadonlyMap<Token, Slot> {
	public readonly size: number
	public readonly [Symbol.toStringTag] = 'TokenOwnerIndex'

	public constructor(
		public readonly base: ReadonlyMap<Token, Slot>,
		public readonly changes: ReadonlyMap<Token, Slot | typeof deletedTokenOwner>,
	) {
		let size = base.size
		for (const [token, value] of changes) {
			const existed = base.has(token)
			if (value === deletedTokenOwner) {
				if (existed) size -= 1
			} else if (!existed) size += 1
		}
		this.size = size
	}

	public get(token: Token): Slot | undefined {
		const changed = this.changes.get(token)
		if (changed === deletedTokenOwner) return undefined
		return changed ?? this.base.get(token)
	}

	public has(token: Token): boolean {
		return this.get(token) !== undefined
	}

	public *entries(): MapIterator<[Token, Slot]> {
		for (const [token, slot] of this.base) {
			if (!this.changes.has(token)) yield [token, slot]
		}
		for (const [token, slot] of this.changes) {
			if (slot !== deletedTokenOwner) yield [token, slot]
		}
	}

	public *keys(): MapIterator<Token> {
		for (const [token] of this.entries()) yield token
	}

	public *values(): MapIterator<Slot> {
		for (const [, slot] of this.entries()) yield slot
	}

	public forEach(
		callbackfn: (value: Slot, key: Token, map: ReadonlyMap<Token, Slot>) => void,
		thisArg?: unknown,
	): void {
		for (const [token, slot] of this.entries()) callbackfn.call(thisArg, slot, token, this)
	}

	public [Symbol.iterator](): MapIterator<[Token, Slot]> {
		return this.entries()
	}
}

class MutableTokenOwnerIndex implements MutableTokenOwnerLookup {
	private readonly base: ReadonlyMap<Token, Slot>
	private readonly changes: Map<Token, Slot | typeof deletedTokenOwner>

	public constructor(previous: ReadonlyMap<Token, Slot>) {
		if (previous instanceof TokenOwnerIndex) {
			this.base = previous.base
			this.changes = new Map(previous.changes)
		} else {
			this.base = previous
			this.changes = new Map()
		}
	}

	public get(token: Token): Slot | undefined {
		const changed = this.changes.get(token)
		if (changed === deletedTokenOwner) return undefined
		return changed ?? this.base.get(token)
	}

	public set(token: Token, slot: Slot): void {
		if (this.base.get(token) === slot) this.changes.delete(token)
		else this.changes.set(token, slot)
	}

	public delete(token: Token): void {
		if (this.base.has(token)) this.changes.set(token, deletedTokenOwner)
		else this.changes.delete(token)
	}

	public finish(): ReadonlyMap<Token, Slot> {
		if (this.changes.size === 0) return this.base
		const compactAt = Math.max(tokenOwnerCompactionMinChanges, Math.ceil(this.base.size / 4))
		if (this.changes.size <= compactAt) return new TokenOwnerIndex(this.base, this.changes)

		// Materialize the overlay directly. Cloning the base and then deleting a broad removal
		// repeats work for every tombstone and retains the base entries until the second pass.
		const compacted = new Map<Token, Slot>()
		for (const [token, slot] of this.base) {
			if (!this.changes.has(token)) compacted.set(token, slot)
		}
		for (const [token, slot] of this.changes) {
			if (slot !== deletedTokenOwner) compacted.set(token, slot)
		}
		return compacted
	}
}

/** Immutable base plus one coalesced change set for sparse token indexes. */
class MapDeltaIndex<K, V> implements ReadonlyMap<K, V> {
	readonly size: number
	readonly [Symbol.toStringTag] = 'MapDeltaIndex'

	constructor(
		readonly base: ReadonlyMap<K, V>,
		readonly changes: ReadonlyMap<K, V | typeof deletedMapValue>,
	) {
		let size = base.size
		for (const [key, value] of changes) {
			const existed = base.has(key)
			if (value === deletedMapValue) {
				if (existed) size -= 1
			} else if (!existed) size += 1
		}
		this.size = size
	}

	get(key: K): V | undefined {
		const changed = this.changes.get(key)
		if (changed === deletedMapValue) return undefined
		return changed ?? this.base.get(key)
	}

	has(key: K): boolean {
		return this.get(key) !== undefined
	}

	*entries(): MapIterator<[K, V]> {
		for (const [key, value] of this.base) if (!this.changes.has(key)) yield [key, value]
		for (const [key, value] of this.changes) {
			if (value !== deletedMapValue) yield [key, value]
		}
	}

	*keys(): MapIterator<K> {
		for (const [key] of this.entries()) yield key
	}

	*values(): MapIterator<V> {
		for (const [, value] of this.entries()) yield value
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this)
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries()
	}
}

type MutableMapLookup<K, V> = {
	get(key: K): V | undefined
	set(key: K, value: V): unknown
	delete(key: K): boolean
}

class MutableMapDeltaIndex<K, V> implements MutableMapLookup<K, V> {
	private readonly base: ReadonlyMap<K, V>
	private readonly changes: Map<K, V | typeof deletedMapValue>

	constructor(previous: ReadonlyMap<K, V>) {
		if (previous instanceof MapDeltaIndex) {
			this.base = previous.base
			this.changes = new Map(previous.changes)
		} else {
			this.base = previous
			this.changes = new Map()
		}
	}

	get(key: K): V | undefined {
		const changed = this.changes.get(key)
		if (changed === deletedMapValue) return undefined
		return changed ?? this.base.get(key)
	}

	set(key: K, value: V): this {
		if (this.base.get(key) === value) this.changes.delete(key)
		else this.changes.set(key, value)
		return this
	}

	delete(key: K): boolean {
		const existed = this.get(key) !== undefined
		if (this.base.has(key)) this.changes.set(key, deletedMapValue)
		else this.changes.delete(key)
		return existed
	}

	finish(): ReadonlyMap<K, V> {
		if (this.changes.size === 0) return this.base
		const compactAt = Math.max(tokenOwnerCompactionMinChanges, Math.ceil(this.base.size / 4))
		if (this.changes.size <= compactAt) return new MapDeltaIndex(this.base, this.changes)
		const compacted = new Map<K, V>()
		for (const [key, value] of this.base) {
			if (!this.changes.has(key)) compacted.set(key, value)
		}
		for (const [key, value] of this.changes) {
			if (value !== deletedMapValue) compacted.set(key, value)
		}
		return compacted
	}
}

const cloneArray = <T>(value: readonly T[]): readonly T[] =>
	value.length === 0 ? (emptyArray as readonly T[]) : [...value]

const finishArray = <T>(value: T[]): readonly T[] =>
	value.length === 0 ? (emptyArray as readonly T[]) : value

const mergeUniqueSlots = (first: readonly Slot[], second: readonly Slot[]): readonly Slot[] => {
	if (first.length === 0) return second
	if (second.length === 0) return first
	const out = [...first]
	for (const slot of second) if (!out.includes(slot)) out.push(slot)
	return out
}

const shallowArrayEqual = (a: readonly unknown[], b: readonly unknown[]): boolean => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

const isDefaultTokenCandidate = (value: NodeKey): value is Token => value !== null

const normalizeExplicitTokens = (decl: ProviderDecl<unknown, unknown>): readonly Token[] => {
	const out: Token[] = []
	const seen = new Set<Token>()
	for (const token of decl.tokens ?? []) {
		if (token === decl.key) continue
		if (seen.has(token)) continue
		seen.add(token)
		out.push(token)
	}
	return cloneArray(out)
}

const composeTokens = (key: NodeKey, explicitTokens: readonly Token[]): readonly Token[] =>
	isDefaultTokenCandidate(key) ? cloneArray([key, ...explicitTokens]) : explicitTokens

const normalizeDecl = <M>(decl: ProviderDecl<unknown, M>): NormalizedProviderDecl<unknown, M> => {
	const explicitTokens = normalizeExplicitTokens(decl)
	return {
		key: decl.key,
		explicitTokens,
		tokens: composeTokens(decl.key, explicitTokens),
		deps: cloneArray(decl.deps ?? []),
		optionalDeps: cloneArray(decl.optionalDeps ?? []),
		cache: decl.create.kind === 'value' ? 'retain' : (decl.cache ?? 'retain'),
		meta: decl.meta,
		create: decl.create,
	}
}

const declEqual = (
	a: NormalizedProviderDecl<unknown, unknown>,
	b: NormalizedProviderDecl<unknown, unknown>,
) =>
	a.key === b.key &&
	a.cache === b.cache &&
	a.meta === b.meta &&
	a.create.kind === b.create.kind &&
	a.create.value === b.create.value &&
	shallowArrayEqual(a.explicitTokens, b.explicitTokens) &&
	shallowArrayEqual(a.deps, b.deps) &&
	shallowArrayEqual(a.optionalDeps, b.optionalDeps)

const createDraftState = <M>(
	base = SlotTable.empty<NormalizedProviderDecl<unknown, M>>(),
	slotLimit = base.length,
	activeCount = 0,
): DraftState<M> => ({
	base,
	changes: new Map(),
	slotLimit,
	activeCount,
	replacementSources: [],
	replacementPairs: new Map(),
})

const draftDeclarationAt = <M>(
	state: DraftState<M>,
	slot: Slot,
): NormalizedProviderDecl<unknown, M> | undefined =>
	state.changes.has(slot) ? state.changes.get(slot) : state.base.get(slot)

const setDraftDeclaration = <M>(
	state: DraftState<M>,
	slot: Slot,
	declaration: NormalizedProviderDecl<unknown, M> | undefined,
): void => {
	const current = draftDeclarationAt(state, slot)
	if (current === declaration) return
	if (current === undefined && declaration !== undefined) state.activeCount += 1
	else if (current !== undefined && declaration === undefined) state.activeCount -= 1
	if (state.base.get(slot) === declaration) state.changes.delete(slot)
	else state.changes.set(slot, declaration)
	state.slotLimit = Math.max(state.slotLimit, slot + 1)
}

const finishDraftState = <M>(state: DraftState<M>): DraftState<M> => {
	if (state.changes.size === 0) {
		return createDraftState(state.base, state.slotLimit, state.activeCount)
	}
	const builder = state.base.mutate()
	for (const [slot, declaration] of state.changes) builder.set(slot, declaration)
	return createDraftState(builder.finish(state.slotLimit), state.slotLimit, state.activeCount)
}

const createBuildScratch = (): BuildScratch => ({
	dirtyMarks: new SlotMarks(),
	affectedMarks: new SlotMarks(),
	changedDependentMarks: new SlotMarks(),
	changedOptionalDependentMarks: new SlotMarks(),
	dirtySlots: [],
	affectedSlots: [],
	affectedStack: [],
	changedDependentSlots: [],
	changedOptionalDependentSlots: [],
})

const resetBuildScratch = (scratch: BuildScratch): void => {
	scratch.dirtyMarks.clear()
	scratch.affectedMarks.clear()
	scratch.changedDependentMarks.clear()
	scratch.changedOptionalDependentMarks.clear()
	scratch.dirtySlots.length = 0
	scratch.affectedSlots.length = 0
	scratch.affectedStack.length = 0
	scratch.changedDependentSlots.length = 0
	scratch.changedOptionalDependentSlots.length = 0
}

const activeKeysOfState = <M>(state: DraftState<M>): readonly NodeKey[] => {
	const out: NodeKey[] = []
	for (let slot = 0; slot < state.slotLimit; slot++) {
		const decl = draftDeclarationAt(state, slot)
		if (decl !== undefined) out.push(decl.key)
	}
	return finishArray(out)
}

const cloneDraftState = <M>(state: DraftState<M>): DraftState<M> => ({
	base: state.base,
	changes: new Map(state.changes),
	slotLimit: state.slotLimit,
	activeCount: state.activeCount,
	replacementSources: [...state.replacementSources],
	replacementPairs: new Map(state.replacementPairs),
})

const computeDirtySlots = <M>(base: DraftState<M>, draft: DraftState<M>): Set<Slot> => {
	const dirty = new Set<Slot>()
	const candidates = new Set([...base.changes.keys(), ...draft.changes.keys()])
	for (const slot of candidates) {
		const baseDecl = draftDeclarationAt(base, slot)
		const draftDecl = draftDeclarationAt(draft, slot)
		if (baseDecl === undefined && draftDecl === undefined) continue
		if (!baseDecl || !draftDecl || !declEqual(baseDecl, draftDecl)) dirty.add(slot)
	}
	return dirty
}

const createGraphDeclaration = <M>(
	decl: NormalizedProviderDecl<unknown, M>,
): GraphDeclaration<M> => ({
	key: decl.key,
	tokens: decl.tokens,
	depTokens: decl.deps,
	optionalDepTokens: decl.optionalDeps,
	cache: decl.cache,
	meta: decl.meta,
	providerKind: decl.create.kind,
})

const resolveTokenSlotFromTable = (
	tokenOwnerSlots: TokenOwnerLookup,
	slotOfKey: (key: NodeKey) => Slot | undefined,
	token: Token,
): Slot | undefined =>
	tokenOwnerSlots.get(token) ??
	(isDefaultTokenCandidate(token) ? slotOfKey(token as NodeKey) : undefined)

const addToMutableSlotListMap = <K>(
	map: MutableMapLookup<K, readonly Slot[] | Slot[]>,
	key: K,
	value: Slot,
	mutated: Set<K>,
) => {
	const current = map.get(key)
	if (!current) {
		map.set(key, [value])
		mutated.add(key)
		return
	}
	if (mutated.has(key)) {
		const next = current as Slot[]
		if (!next.includes(value)) next.push(value)
		return
	}
	if (current.includes(value)) return
	const next = [...current, value]
	map.set(key, next)
	mutated.add(key)
}

const removeFromMutableSlotListMap = <K>(
	map: MutableMapLookup<K, readonly Slot[] | Slot[]>,
	key: K,
	value: Slot,
	mutated: Set<K>,
) => {
	const current = map.get(key)
	if (!current) return
	let next: Slot[]
	if (mutated.has(key)) next = current as Slot[]
	else {
		next = [...current]
		map.set(key, next)
		mutated.add(key)
	}
	const idx = next.indexOf(value)
	if (idx < 0) return
	next.splice(idx, 1)
	if (next.length === 0) map.delete(key)
}

const addToSlotListMap = <K>(map: Map<K, Slot[]>, key: K, value: Slot): void => {
	const current = map.get(key)
	if (!current) {
		map.set(key, [value])
		return
	}
	if (!current.includes(value)) current.push(value)
}

const markSlot = (marks: SlotMarks, slots: Slot[], slot: Slot): boolean => {
	if (!Number.isInteger(slot) || slot < 0 || slot >= slotTableMaxLength) return false
	if (marks.has(slot)) return false
	marks.add(slot)
	slots.push(slot)
	return true
}

const ensureMutableSlotList = (
	table: SlotTableBuilder<readonly Slot[] | Slot[]>,
	slot: Slot,
	mutatedMarks: SlotMarks,
	mutatedSlots: Slot[],
): Slot[] => {
	const current = table.get(slot)
	if (!current) {
		const created: Slot[] = []
		table.set(slot, created)
		markSlot(mutatedMarks, mutatedSlots, slot)
		return created
	}
	// A marked slot may have been collapsed back to the shared empty sentinel.
	if (mutatedMarks.has(slot) && current !== emptySlotArray) return current as Slot[]
	const next = [...current]
	table.set(slot, next)
	markSlot(mutatedMarks, mutatedSlots, slot)
	return next
}

const addToMutableSlotTable = (
	table: SlotTableBuilder<readonly Slot[] | Slot[]>,
	slot: Slot,
	value: Slot,
	mutatedMarks: SlotMarks,
	mutatedSlots: Slot[],
) => {
	const next = ensureMutableSlotList(table, slot, mutatedMarks, mutatedSlots)
	if (!next.includes(value)) next.push(value)
}

const removeFromMutableSlotTable = (
	table: SlotTableBuilder<readonly Slot[] | Slot[]>,
	slot: Slot,
	value: Slot,
	mutatedMarks: SlotMarks,
	mutatedSlots: Slot[],
) => {
	const current = table.get(slot)
	if (!current) return
	const next = ensureMutableSlotList(table, slot, mutatedMarks, mutatedSlots)
	const idx = next.indexOf(value)
	if (idx < 0) return
	next.splice(idx, 1)
	if (next.length === 0) table.set(slot, emptySlotArray)
}

const computeRetargetedTokens = (
	touchedTokens: ReadonlySet<Token>,
	resolvePrev: (token: Token) => NodeKey | undefined,
	resolveNext: (token: Token) => NodeKey | undefined,
) => {
	const out: Array<{ token: Token; from?: NodeKey; to?: NodeKey }> = []
	for (const token of touchedTokens) {
		const from = resolvePrev(token)
		const to = resolveNext(token)
		if (from !== to) out.push({ token, from, to })
	}
	return out
}

const visitCycleSlots = (
	slot: Slot,
	depsOf: (slot: Slot) => readonly Slot[],
	exists: (slot: Slot) => boolean,
	keyOf: (slot: Slot) => NodeKey | undefined,
	color: SlotColors,
	stack: Slot[],
	stackIndex: Map<Slot, number>,
	issues: GraphBuildIssue[],
) => {
	const seen = color.get(slot) ?? 0
	if (seen === 2) return
	if (seen === 1) {
		recordCycleIssue(slot, keyOf, stack, stackIndex, issues)
		return
	}

	type Frame = { slot: Slot; deps: readonly Slot[]; next: number }
	const frames: Frame[] = []
	color.set(slot, 1)
	stackIndex.set(slot, stack.length)
	stack.push(slot)
	frames.push({ slot, deps: depsOf(slot), next: 0 })

	while (frames.length > 0) {
		const frame = frames.at(-1)!
		if (frame.next >= frame.deps.length) {
			frames.pop()
			stack.pop()
			stackIndex.delete(frame.slot)
			color.set(frame.slot, 2)
			continue
		}

		const dep = frame.deps[frame.next++]!
		if (!exists(dep)) continue
		const depColor = color.get(dep) ?? 0
		if (depColor === 2) continue
		if (depColor === 1) {
			recordCycleIssue(dep, keyOf, stack, stackIndex, issues)
			continue
		}

		color.set(dep, 1)
		stackIndex.set(dep, stack.length)
		stack.push(dep)
		frames.push({ slot: dep, deps: depsOf(dep), next: 0 })
	}
}

const recordCycleIssue = (
	slot: Slot,
	keyOf: (slot: Slot) => NodeKey | undefined,
	stack: readonly Slot[],
	stackIndex: ReadonlyMap<Slot, number>,
	issues: GraphBuildIssue[],
) => {
	const idx = stackIndex.get(slot) ?? -1
	const start = idx >= 0 ? idx : 0
	const chain: NodeKey[] = []
	for (let i = start; i < stack.length; i++) {
		const key = keyOf(stack[i]!)
		if (key !== undefined) chain.push(key)
	}
	const closing = keyOf(slot)
	if (closing !== undefined) chain.push(closing)
	if (chain.length > 0) issues.push({ kind: 'CircularDependency', chain })
}

const compileActivator = (
	create: ProviderCreate<unknown>,
	depSlots: readonly Slot[],
): Activator => {
	switch (create.kind) {
		case 'value':
			return () => create.value
		case 'class': {
			const Ctor = create.value as new (...args: any[]) => unknown
			switch (depSlots.length) {
				case 0:
					return () => new Ctor()
				case 1:
					return (runtime) => new Ctor(runtime.ensureBySlot(depSlots[0]!))
				case 2:
					return (runtime) =>
						new Ctor(runtime.ensureBySlot(depSlots[0]!), runtime.ensureBySlot(depSlots[1]!))
				case 3:
					return (runtime) =>
						new Ctor(
							runtime.ensureBySlot(depSlots[0]!),
							runtime.ensureBySlot(depSlots[1]!),
							runtime.ensureBySlot(depSlots[2]!),
						)
				default:
					return (runtime) => {
						const args = Array<unknown>(depSlots.length)
						for (let i = 0; i < depSlots.length; i++) args[i] = runtime.ensureBySlot(depSlots[i]!)
						return new Ctor(...args)
					}
			}
		}
		case 'factory': {
			const factory = create.value as (...deps: readonly unknown[]) => unknown
			switch (depSlots.length) {
				case 0:
					return () => factory()
				case 1:
					return (runtime) => factory(runtime.ensureBySlot(depSlots[0]!))
				case 2:
					return (runtime) =>
						factory(runtime.ensureBySlot(depSlots[0]!), runtime.ensureBySlot(depSlots[1]!))
				case 3:
					return (runtime) =>
						factory(
							runtime.ensureBySlot(depSlots[0]!),
							runtime.ensureBySlot(depSlots[1]!),
							runtime.ensureBySlot(depSlots[2]!),
						)
				default:
					return (runtime) => {
						const args = Array<unknown>(depSlots.length)
						for (let i = 0; i < depSlots.length; i++) args[i] = runtime.ensureBySlot(depSlots[i]!)
						return factory(...args)
					}
			}
		}
	}
}

const graphSnapshotTables = Symbol('graphSnapshotTables')
const graphSnapshotIndexes = Symbol('graphSnapshotIndexes')

type GraphSnapshotTables<M> = Readonly<{
	declarations: SlotTable<GraphDeclaration<M>>
	creates: SlotTable<ProviderCreate<unknown>>
	deps: SlotTable<readonly Slot[]>
	dependents: SlotTable<readonly Slot[]>
	optionalDeps: SlotTable<readonly Slot[]>
	optionalDependents: SlotTable<readonly Slot[]>
}>

type GraphSnapshotIndexes = Readonly<{
	tokenConsumers: ReadonlyMap<Token, readonly Slot[]>
	optionalTokenConsumers: ReadonlyMap<Token, readonly Slot[]>
}>

export class GraphSnapshot<M = unknown> {
	public readonly revision: number
	private readonly activeNodeCount: number
	private readonly keySlots: NodeKeySlotRegistry
	private readonly slotLimit: number
	private readonly tables: GraphSnapshotTables<M>
	private readonly tokenOwnerSlotMap: ReadonlyMap<Token, Slot>
	private readonly tokenConsumerSlotsMap: ReadonlyMap<Token, readonly Slot[]>
	private readonly optionalTokenConsumerSlotsMap: ReadonlyMap<Token, readonly Slot[]>
	private readonly activatorsBySlot: Array<Activator | undefined> = []
	private readonly depsKeysCache: Array<readonly NodeKey[] | undefined> = []
	private readonly dependentsKeysCache: Array<readonly NodeKey[] | undefined> = []
	private readonly optionalDepsKeysCache: Array<readonly NodeKey[] | undefined> = []
	private readonly optionalDependentsKeysCache: Array<readonly NodeKey[] | undefined> = []

	public constructor(args: {
		revision: number
		activeCount: number
		keySlots: NodeKeySlotRegistry
		slotCount: number
		declarationsBySlot: SlotTable<GraphDeclaration<M>>
		createsBySlot: SlotTable<ProviderCreate<unknown>>
		depsBySlot: SlotTable<readonly Slot[]>
		dependentsBySlot: SlotTable<readonly Slot[]>
		optionalDepsBySlot: SlotTable<readonly Slot[]>
		optionalDependentsBySlot: SlotTable<readonly Slot[]>
		tokenOwnerSlots: ReadonlyMap<Token, Slot>
		tokenConsumerSlots: ReadonlyMap<Token, readonly Slot[]>
		optionalTokenConsumerSlots: ReadonlyMap<Token, readonly Slot[]>
	}) {
		this.revision = args.revision
		this.activeNodeCount = args.activeCount
		this.keySlots = args.keySlots
		this.slotLimit = args.slotCount
		this.tables = Object.freeze({
			declarations: args.declarationsBySlot,
			creates: args.createsBySlot,
			deps: args.depsBySlot,
			dependents: args.dependentsBySlot,
			optionalDeps: args.optionalDepsBySlot,
			optionalDependents: args.optionalDependentsBySlot,
		})
		this.tokenOwnerSlotMap = args.tokenOwnerSlots
		this.tokenConsumerSlotsMap = args.tokenConsumerSlots
		this.optionalTokenConsumerSlotsMap = args.optionalTokenConsumerSlots
	}

	public static empty<M = unknown>(keySlots = new NodeKeySlotRegistry()): GraphSnapshot<M> {
		return new GraphSnapshot<M>({
			revision: 0,
			activeCount: 0,
			keySlots,
			slotCount: 0,
			declarationsBySlot: SlotTable.empty(),
			createsBySlot: SlotTable.empty(),
			depsBySlot: SlotTable.empty(),
			dependentsBySlot: SlotTable.empty(),
			optionalDepsBySlot: SlotTable.empty(),
			optionalDependentsBySlot: SlotTable.empty(),
			tokenOwnerSlots: new Map(),
			tokenConsumerSlots: new Map(),
			optionalTokenConsumerSlots: new Map(),
		})
	}

	public resolve(token: Token): NodeKey | undefined {
		const slot = this.resolveSlot(token)
		return slot === undefined ? undefined : this.keyOf(slot)
	}

	public resolveSlot(token: Token): Slot | undefined {
		return (
			this.tokenOwnerSlotMap.get(token) ??
			(isDefaultTokenCandidate(token) ? this.slotOf(token as NodeKey) : undefined)
		)
	}

	public has(nodeKey: NodeKey): boolean {
		return this.slotOf(nodeKey) !== undefined
	}

	public declaration(nodeKey: NodeKey): GraphDeclaration<M> | undefined {
		const slot = this.slotOf(nodeKey)
		return slot === undefined ? undefined : this.tables.declarations.get(slot)
	}

	public depsOf(nodeKey: NodeKey): readonly NodeKey[] {
		const slot = this.slotOf(nodeKey)
		return slot === undefined ? (emptyArray as readonly NodeKey[]) : this.depsOfSlot(slot)
	}

	public dependentsOf(nodeKey: NodeKey): readonly NodeKey[] {
		const slot = this.slotOf(nodeKey)
		return slot === undefined ? (emptyArray as readonly NodeKey[]) : this.dependentsOfSlot(slot)
	}

	public optionalDepsOf(nodeKey: NodeKey): readonly NodeKey[] {
		const slot = this.slotOf(nodeKey)
		return slot === undefined ? (emptyArray as readonly NodeKey[]) : this.optionalDepsOfSlot(slot)
	}

	public optionalDependentsOf(nodeKey: NodeKey): readonly NodeKey[] {
		const slot = this.slotOf(nodeKey)
		return slot === undefined
			? (emptyArray as readonly NodeKey[])
			: this.optionalDependentsOfSlot(slot)
	}

	public consumers(token: Token): readonly NodeKey[] {
		const slots = this.tokenConsumerSlotsMap.get(token)
		return slots ? this.mapSlotsToKeys(slots) : (emptyArray as readonly NodeKey[])
	}

	public optionalConsumers(token: Token): readonly NodeKey[] {
		const slots = this.optionalTokenConsumerSlotsMap.get(token)
		return slots ? this.mapSlotsToKeys(slots) : (emptyArray as readonly NodeKey[])
	}

	public activatorAtSlot(slot: Slot): Activator {
		return this.activatorBySlot(slot)
	}

	public *keys(): IterableIterator<NodeKey> {
		for (let slot = 0; slot < this.slotLimit; slot++) {
			const key = this.keySlots.keyAt(slot)
			if (key !== undefined && this.tables.declarations.get(slot) !== undefined) yield key
		}
	}

	public slotOf(nodeKey: NodeKey): Slot | undefined {
		const slot = this.keySlots.lookup(nodeKey)
		if (slot === undefined || slot >= this.slotLimit) return undefined
		return this.tables.declarations.get(slot)?.key === nodeKey ? slot : undefined
	}

	public keyOf(slot: Slot): NodeKey | undefined {
		if (slot < 0 || slot >= this.slotLimit || !this.tables.declarations.get(slot)) return undefined
		return this.keySlots.keyAt(slot)
	}

	public slotCount(): number {
		return this.slotLimit
	}

	public activeCount(): number {
		return this.activeNodeCount
	}

	public declarationAtSlot(slot: Slot): GraphDeclaration<M> | undefined {
		return this.tables.declarations.get(slot)
	}

	public depSlotsOf(slot: Slot): readonly Slot[] {
		return this.tables.deps.get(slot) ?? emptySlotArray
	}

	public dependentSlotsOf(slot: Slot): readonly Slot[] {
		return this.tables.dependents.get(slot) ?? emptySlotArray
	}

	public optionalDepSlotsOf(slot: Slot): readonly Slot[] {
		return this.tables.optionalDeps.get(slot) ?? emptySlotArray
	}

	public optionalDependentSlotsOf(slot: Slot): readonly Slot[] {
		return this.tables.optionalDependents.get(slot) ?? emptySlotArray
	}

	public orderDepSlotsOf(slot: Slot): readonly Slot[] {
		return mergeUniqueSlots(this.depSlotsOf(slot), this.optionalDepSlotsOf(slot))
	}

	public orderDependentSlotsOf(slot: Slot): readonly Slot[] {
		return mergeUniqueSlots(this.dependentSlotsOf(slot), this.optionalDependentSlotsOf(slot))
	}

	public tokenConsumerSlotsOf(token: Token): readonly Slot[] {
		return this.tokenConsumerSlotsMap.get(token) ?? emptySlotArray
	}

	public optionalTokenConsumerSlotsOf(token: Token): readonly Slot[] {
		return this.optionalTokenConsumerSlotsMap.get(token) ?? emptySlotArray
	}

	public tokenOwnerSlots(): ReadonlyMap<Token, Slot> {
		return this.tokenOwnerSlotMap
	}

	public tokenConsumerSlots(): ReadonlyMap<Token, readonly Slot[]> {
		return this.tokenConsumerSlotsMap
	}

	public optionalTokenConsumerSlots(): ReadonlyMap<Token, readonly Slot[]> {
		return this.optionalTokenConsumerSlotsMap
	}

	public declarationsBySlot(): SlotTable<GraphDeclaration<M>> {
		return this.tables.declarations
	}

	public createsBySlot(): SlotTable<ProviderCreate<unknown>> {
		return this.tables.creates
	}

	public depsBySlot(): SlotTable<readonly Slot[]> {
		return this.tables.deps
	}

	public dependentsBySlot(): SlotTable<readonly Slot[]> {
		return this.tables.dependents
	}

	public optionalDepsBySlot(): SlotTable<readonly Slot[]> {
		return this.tables.optionalDeps
	}

	public optionalDependentsBySlot(): SlotTable<readonly Slot[]> {
		return this.tables.optionalDependents
	}

	[graphSnapshotTables](): GraphSnapshotTables<M> {
		return this.tables
	}

	[graphSnapshotIndexes](): GraphSnapshotIndexes {
		return {
			tokenConsumers: this.tokenConsumerSlotsMap,
			optionalTokenConsumers: this.optionalTokenConsumerSlotsMap,
		}
	}

	private depsOfSlot(slot: Slot): readonly NodeKey[] {
		const cached = this.depsKeysCache[slot]
		if (cached) return cached
		const mapped = this.mapSlotsToKeys(this.tables.deps.get(slot) ?? emptySlotArray)
		this.depsKeysCache[slot] = mapped
		return mapped
	}

	private dependentsOfSlot(slot: Slot): readonly NodeKey[] {
		const cached = this.dependentsKeysCache[slot]
		if (cached) return cached
		const mapped = this.mapSlotsToKeys(this.tables.dependents.get(slot) ?? emptySlotArray)
		this.dependentsKeysCache[slot] = mapped
		return mapped
	}

	private optionalDepsOfSlot(slot: Slot): readonly NodeKey[] {
		const cached = this.optionalDepsKeysCache[slot]
		if (cached) return cached
		const mapped = this.mapSlotsToKeys(this.tables.optionalDeps.get(slot) ?? emptySlotArray)
		this.optionalDepsKeysCache[slot] = mapped
		return mapped
	}

	private optionalDependentsOfSlot(slot: Slot): readonly NodeKey[] {
		const cached = this.optionalDependentsKeysCache[slot]
		if (cached) return cached
		const mapped = this.mapSlotsToKeys(this.tables.optionalDependents.get(slot) ?? emptySlotArray)
		this.optionalDependentsKeysCache[slot] = mapped
		return mapped
	}

	private activatorBySlot(slot: Slot): Activator {
		const cached = this.activatorsBySlot[slot]
		if (cached) return cached
		const create = this.tables.creates.get(slot)
		if (!create) throw new Error('Unknown node key')
		const activator = compileActivator(create, this.tables.deps.get(slot) ?? emptySlotArray)
		this.activatorsBySlot[slot] = activator
		return activator
	}

	private mapSlotsToKeys(slots: readonly Slot[]): readonly NodeKey[] {
		if (slots.length === 0) return emptyArray as readonly NodeKey[]
		const out: NodeKey[] = []
		for (let i = 0; i < slots.length; i++) {
			const key = this.keyOf(slots[i]!)
			if (key !== undefined) out.push(key)
		}
		return out.length === 0 ? (emptyArray as readonly NodeKey[]) : out
	}
}

export class Runtime<M = unknown> {
	private readonly resolvingMarks: number[] = []
	private readonly retainedValues: unknown[] = []
	private readonly retainedRevisions: number[] = []
	private readonly retainedStoreRevisions: number[] = []
	private readonly retainedKnown: number[] = []

	public constructor(
		public readonly graph: GraphSnapshot<M>,
		public readonly instances: InstanceStore<NodeKey, unknown> = new InstanceStore(),
	) {}

	private loadRetainedAtSlot<T>(slot: Slot, nodeKey: NodeKey): T | undefined {
		const storeRevision = this.instances.getRevision()
		if (this.retainedKnown[slot] === 1 && this.retainedStoreRevisions[slot] === storeRevision)
			return this.retainedValues[slot] as T | undefined
		const keyRevision = this.instances.getKeyRevision(nodeKey)
		if (this.retainedKnown[slot] === 1 && this.retainedRevisions[slot] === keyRevision) {
			this.retainedStoreRevisions[slot] = storeRevision
			return this.retainedValues[slot] as T | undefined
		}
		if (keyRevision === 0) {
			this.clearRetainedAtSlot(slot)
			return undefined
		}
		const value = this.instances.peek(nodeKey) as T | undefined
		this.retainedValues[slot] = value
		this.retainedRevisions[slot] = keyRevision
		this.retainedStoreRevisions[slot] = storeRevision
		this.retainedKnown[slot] = 1
		return value
	}

	private storeRetainedAtSlot(slot: Slot, nodeKey: NodeKey, value: unknown): void {
		this.instances.set(nodeKey, value)
		this.retainedValues[slot] = value
		this.retainedRevisions[slot] = this.instances.getKeyRevision(nodeKey)
		this.retainedStoreRevisions[slot] = this.instances.getRevision()
		this.retainedKnown[slot] = 1
	}

	private clearRetainedAtSlot(slot: Slot): void {
		this.retainedKnown[slot] = 0
		this.retainedRevisions[slot] = 0
		this.retainedStoreRevisions[slot] = 0
		this.retainedValues[slot] = undefined
	}

	private resolveHandle(handle: Token | NodeKey): {
		asKey: boolean
		slot: Slot | undefined
		nodeKey: NodeKey | undefined
	} {
		if (this.graph.has(handle as NodeKey)) {
			const nodeKey = handle as NodeKey
			return {
				asKey: true,
				slot: this.graph.slotOf(nodeKey),
				nodeKey,
			}
		}

		const slot = this.graph.resolveSlot(handle as Token)
		return {
			asKey: false,
			slot,
			nodeKey: slot === undefined ? undefined : this.graph.keyOf(slot),
		}
	}

	public peekByKey<T>(nodeKey: NodeKey): T | undefined {
		const slot = this.graph.slotOf(nodeKey)
		if (slot !== undefined) {
			const declaration = this.graph.declarationAtSlot(slot)
			if (declaration?.cache === 'retain') return this.loadRetainedAtSlot(slot, nodeKey)
		}
		return this.instances.peek(nodeKey) as T | undefined
	}

	public peekByToken<T>(token: Token): T | undefined {
		const slot = this.graph.resolveSlot(token)
		if (slot === undefined) return undefined
		const nodeKey = this.graph.keyOf(slot)
		return nodeKey === undefined ? undefined : (this.peekByKey(nodeKey) as T | undefined)
	}

	public peek<T>(handle: Token | NodeKey): T | undefined {
		const resolved = this.resolveHandle(handle)
		return resolved.nodeKey === undefined
			? undefined
			: (this.peekByKey(resolved.nodeKey) as T | undefined)
	}

	public ensureBySlot<T>(slot: Slot): T {
		const declaration = this.graph.declarationAtSlot(slot)
		const nodeKey = this.graph.keyOf(slot)
		if (!declaration || nodeKey === undefined) throw new Error('Unknown node key')
		if (declaration.cache === 'retain') {
			const cached = this.loadRetainedAtSlot<T>(slot, nodeKey)
			if (cached !== undefined) return cached as T
			if (this.retainedKnown[slot] === 1) return cached as T
		}
		if (this.resolvingMarks[slot] === 1) throw new Error('Unexpected runtime cycle')
		this.resolvingMarks[slot] = 1
		try {
			const value = this.graph.activatorAtSlot(slot)(this) as T
			if (declaration.cache === 'retain') this.storeRetainedAtSlot(slot, nodeKey, value)
			return value
		} finally {
			this.resolvingMarks[slot] = 0
		}
	}

	public ensureByKey<T>(nodeKey: NodeKey): T {
		const slot = this.graph.slotOf(nodeKey)
		if (slot === undefined) throw new Error('Unknown node key')
		return this.ensureBySlot(slot)
	}

	public ensureByToken<T>(token: Token): T {
		const slot = this.graph.resolveSlot(token)
		if (slot === undefined) throw new Error('Unknown token')
		return this.ensureBySlot(slot)
	}

	public ensure<T>(handle: Token | NodeKey): T {
		const resolved = this.resolveHandle(handle)
		if (resolved.slot === undefined) {
			throw new Error(resolved.asKey ? 'Unknown node key' : 'Unknown token')
		}
		return this.ensureBySlot(resolved.slot)
	}

	public delete(handle: Token | NodeKey): void {
		const resolved = this.resolveHandle(handle)
		if (resolved.slot !== undefined) this.clearRetainedAtSlot(resolved.slot)
		if (resolved.nodeKey === undefined) return
		this.instances.delete(resolved.nodeKey)
	}

	public deleteMany(keys: Iterable<NodeKey>): void {
		const handles = Array.isArray(keys) ? keys : [...keys]
		for (const key of handles) {
			const slot = this.graph.slotOf(key)
			if (slot !== undefined) this.clearRetainedAtSlot(slot)
		}
		this.instances.deleteMany(handles)
	}
}

const buildFullSnapshot = <M>(
	state: DraftState<M>,
	keySlots: NodeKeySlotRegistry,
	revision: number,
): Result<GraphSnapshot<M>, GraphBuildError> => {
	const issues: GraphBuildIssue[] = []
	const declarationsBySlot: Array<GraphDeclaration<M> | undefined> = []
	const createsBySlot: Array<ProviderCreate<unknown> | undefined> = []
	const slotOfKey = (key: NodeKey): Slot | undefined => {
		const slot = keySlots.lookup(key)
		return slot !== undefined && draftDeclarationAt(state, slot)?.key === key ? slot : undefined
	}
	for (let slot = 0; slot < state.slotLimit; slot++) {
		const decl = draftDeclarationAt(state, slot)
		if (!decl) continue
		declarationsBySlot[slot] = createGraphDeclaration(decl)
		createsBySlot[slot] = decl.create
	}

	const tokenOwnerSlots = new Map<Token, Slot>()
	for (let slot = 0; slot < state.slotLimit; slot++) {
		const decl = draftDeclarationAt(state, slot)
		if (!decl) continue
		if (decl.create.kind === 'value' && (decl.deps.length > 0 || decl.optionalDeps.length > 0)) {
			issues.push({
				kind: 'InvalidDeclaration',
				nodeKey: decl.key,
				message: 'value providers can not declare dependencies',
			})
		}
		for (const token of decl.explicitTokens) {
			const ownerSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, token)
			if (ownerSlot === undefined || ownerSlot === slot) tokenOwnerSlots.set(token, slot)
			else {
				const ownerKey = keySlots.keyAt(ownerSlot)
				if (ownerKey !== undefined) {
					issues.push({
						kind: 'TokenConflict',
						token,
						owners: cloneArray([ownerKey, decl.key]),
					})
				}
			}
		}
	}

	const depsBySlot: Array<readonly Slot[] | undefined> = Array(state.slotLimit)
	const dependentsBySlot: Array<readonly Slot[] | undefined> = Array(state.slotLimit)
	const optionalDepsBySlot: Array<readonly Slot[] | undefined> = Array(state.slotLimit)
	const optionalDependentsBySlot: Array<readonly Slot[] | undefined> = Array(state.slotLimit)
	const tokenConsumerSlots = new Map<Token, Slot[]>()
	const optionalTokenConsumerSlots = new Map<Token, Slot[]>()

	for (let slot = 0; slot < state.slotLimit; slot++) {
		const decl = draftDeclarationAt(state, slot)
		if (!decl) continue
		const resolvedDeps: Slot[] = []
		for (const depToken of decl.deps) {
			const consumers = tokenConsumerSlots.get(depToken)
			if (consumers) {
				if (!consumers.includes(slot)) consumers.push(slot)
			} else tokenConsumerSlots.set(depToken, [slot])
			const depSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, depToken)
			if (depSlot === undefined) {
				issues.push({ kind: 'MissingDependency', nodeKey: decl.key, token: depToken })
				continue
			}
			resolvedDeps.push(depSlot)
			const dependents = dependentsBySlot[depSlot]
			if (dependents) {
				const next = dependents as Slot[]
				if (!next.includes(slot)) next.push(slot)
			} else dependentsBySlot[depSlot] = [slot]
		}
		depsBySlot[slot] = finishArray(resolvedDeps)
		const resolvedOptionalDeps: Slot[] = []
		for (const depToken of decl.optionalDeps) {
			const consumers = optionalTokenConsumerSlots.get(depToken)
			if (consumers) {
				if (!consumers.includes(slot)) consumers.push(slot)
			} else optionalTokenConsumerSlots.set(depToken, [slot])
			const depSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, depToken)
			if (depSlot === undefined) continue
			if (!resolvedOptionalDeps.includes(depSlot)) resolvedOptionalDeps.push(depSlot)
			const dependents = optionalDependentsBySlot[depSlot]
			if (dependents) {
				const next = dependents as Slot[]
				if (!next.includes(slot)) next.push(slot)
			} else optionalDependentsBySlot[depSlot] = [slot]
		}
		optionalDepsBySlot[slot] = finishArray(resolvedOptionalDeps)
	}

	if (issues.length === 0) {
		const color = new SlotColors()
		const stack: Slot[] = []
		const stackIndex = new Map<Slot, number>()
		for (let slot = 0; slot < state.slotLimit; slot++) {
			if (!declarationsBySlot[slot] || color.has(slot)) continue
			visitCycleSlots(
				slot,
				(current) =>
					mergeUniqueSlots(
						depsBySlot[current] ?? emptySlotArray,
						optionalDepsBySlot[current] ?? emptySlotArray,
					),
				(current) => declarationsBySlot[current] !== undefined,
				(current) => keySlots.keyAt(current),
				color,
				stack,
				stackIndex,
				issues,
			)
		}
	}

	if (issues.length > 0) return err(new GraphBuildError(issues))

	for (let slot = 0; slot < dependentsBySlot.length; slot++) {
		const dependents = dependentsBySlot[slot]
		if (!dependents) {
			dependentsBySlot[slot] = emptySlotArray
			continue
		}
		dependentsBySlot[slot] = finishArray(dependents as Slot[])
	}
	for (let slot = 0; slot < optionalDependentsBySlot.length; slot++) {
		const dependents = optionalDependentsBySlot[slot]
		optionalDependentsBySlot[slot] = dependents ? finishArray(dependents as Slot[]) : emptySlotArray
	}

	return ok(
		new GraphSnapshot<M>({
			revision,
			activeCount: state.activeCount,
			keySlots,
			slotCount: state.slotLimit,
			declarationsBySlot: SlotTable.fromArray(declarationsBySlot),
			createsBySlot: SlotTable.fromArray(createsBySlot),
			depsBySlot: SlotTable.fromArray(depsBySlot),
			dependentsBySlot: SlotTable.fromArray(dependentsBySlot),
			optionalDepsBySlot: SlotTable.fromArray(optionalDepsBySlot),
			optionalDependentsBySlot: SlotTable.fromArray(optionalDependentsBySlot),
			tokenOwnerSlots,
			tokenConsumerSlots: new Map(
				[...tokenConsumerSlots.entries()].map(([token, slots]) => [token, finishArray(slots)]),
			),
			optionalTokenConsumerSlots: new Map(
				[...optionalTokenConsumerSlots.entries()].map(([token, slots]) => [
					token,
					finishArray(slots),
				]),
			),
		}),
	)
}

const finalizeChangedTokenConsumerSlots = (
	map: MutableMapDeltaIndex<Token, readonly Slot[] | Slot[]>,
	changed: ReadonlySet<Token>,
): ReadonlyMap<Token, readonly Slot[]> => {
	for (const token of changed) {
		const slots = map.get(token)
		if (!slots) continue
		map.set(token, finishArray(slots as Slot[]))
	}
	return map.finish() as ReadonlyMap<Token, readonly Slot[]>
}

const updateTokenOwnersForDirtySlots = <M>(args: {
	prevState: DraftState<M>
	nextState: DraftState<M>
	dirty: ReadonlySet<Slot>
	tokenOwnerSlots: MutableTokenOwnerLookup
	touchedTokens: Set<Token>
	slotOfKey: (key: NodeKey) => Slot | undefined
	keyOfSlot: (slot: Slot) => NodeKey | undefined
	issues: GraphBuildIssue[]
}): void => {
	const {
		prevState,
		nextState,
		dirty,
		tokenOwnerSlots,
		touchedTokens,
		slotOfKey,
		keyOfSlot,
		issues,
	} = args

	for (const slot of dirty) {
		const before = draftDeclarationAt(prevState, slot)
		if (!before) continue
		for (const token of before.tokens) touchedTokens.add(token)
		for (const token of before.explicitTokens) {
			const ownerSlot = tokenOwnerSlots.get(token)
			if (ownerSlot !== undefined && ownerSlot === slot) tokenOwnerSlots.delete(token)
		}
	}

	for (const slot of dirty) {
		const after = draftDeclarationAt(nextState, slot)
		if (!after) continue
		for (const token of after.tokens) touchedTokens.add(token)
		if (isDefaultTokenCandidate(after.key)) {
			const ownerSlot = tokenOwnerSlots.get(after.key)
			if (ownerSlot !== undefined && ownerSlot !== slot) {
				const ownerKey = keyOfSlot(ownerSlot)
				if (ownerKey !== undefined) {
					issues.push({
						kind: 'TokenConflict',
						token: after.key,
						owners: cloneArray([ownerKey, after.key]),
					})
				}
			}
		}
		for (const token of after.explicitTokens) {
			const ownerSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, token)
			if (ownerSlot === undefined || ownerSlot === slot) tokenOwnerSlots.set(token, slot)
			else {
				const ownerKey = keyOfSlot(ownerSlot)
				if (ownerKey !== undefined) {
					issues.push({
						kind: 'TokenConflict',
						token,
						owners: cloneArray([ownerKey, after.key]),
					})
				}
			}
		}
	}
}

const canReuseTokenOwnerSlots = <M>(
	prevState: DraftState<M>,
	nextState: DraftState<M>,
	dirty: ReadonlySet<Slot>,
): boolean => {
	for (const slot of dirty) {
		const before = draftDeclarationAt(prevState, slot)
		const after = draftDeclarationAt(nextState, slot)
		if (
			!before ||
			!after ||
			before.key !== after.key ||
			!shallowArrayEqual(before.explicitTokens, after.explicitTokens)
		) {
			return false
		}
	}
	return true
}

const validateDirtyDeclarations = <M>(
	nextState: DraftState<M>,
	dirty: ReadonlySet<Slot>,
	issues: GraphBuildIssue[],
): void => {
	for (const slot of dirty) {
		const after = draftDeclarationAt(nextState, slot)
		if (!after) continue
		if (after.create.kind === 'value' && (after.deps.length > 0 || after.optionalDeps.length > 0)) {
			issues.push({
				kind: 'InvalidDeclaration',
				nodeKey: after.key,
				message: 'value providers can not declare dependencies',
			})
		}
	}
}

const collectAffectedSlots = <M>(
	prev: GraphSnapshot<M>,
	dirty: ReadonlySet<Slot>,
	retargetedTokens: readonly { token: Token }[],
	scratch: BuildScratch,
): readonly Slot[] => {
	const dirtyMarks = scratch.dirtyMarks
	const dirtySlots = scratch.dirtySlots
	const affectedMarks = scratch.affectedMarks
	const affectedSlots = scratch.affectedSlots
	const affectedStack = scratch.affectedStack
	let dirtyPreviousActiveCount = 0

	for (const slot of dirty) {
		markSlot(dirtyMarks, dirtySlots, slot)
		if (prev.declarationAtSlot(slot) !== undefined) dirtyPreviousActiveCount += 1
	}

	for (let i = 0; i < dirtySlots.length; i++) {
		const slot = dirtySlots[i]!
		if (markSlot(affectedMarks, affectedStack, slot)) affectedSlots.push(slot)
	}
	// Every previous node is already affected, so token retargeting and dependent propagation
	// cannot discover another slot. The retargeted-token delta is still computed and reported.
	if (dirtyPreviousActiveCount === prev.activeCount()) return affectedSlots
	for (let i = 0; i < retargetedTokens.length; i++) {
		const { token } = retargetedTokens[i]!
		for (const consumerSlot of prev.tokenConsumerSlotsOf(token)) {
			if (markSlot(affectedMarks, affectedStack, consumerSlot)) affectedSlots.push(consumerSlot)
		}
		for (const consumerSlot of prev.optionalTokenConsumerSlotsOf(token)) {
			if (markSlot(affectedMarks, affectedStack, consumerSlot)) affectedSlots.push(consumerSlot)
		}
	}
	while (affectedStack.length > 0) {
		const current = affectedStack.pop()!
		const dependents = prev.orderDependentSlotsOf(current)
		for (let i = 0; i < dependents.length; i++) {
			const dependentSlot = dependents[i]!
			if (markSlot(affectedMarks, affectedStack, dependentSlot)) affectedSlots.push(dependentSlot)
		}
	}

	return affectedSlots
}

const collectGraphDelta = <M>(args: {
	prevState: DraftState<M>
	nextState: DraftState<M>
	keySlots: NodeKeySlotRegistry
	dirtySlots: readonly Slot[]
	affectedSlots: readonly Slot[]
	retargetedTokens: readonly {
		token: Token
		from?: NodeKey
		to?: NodeKey
	}[]
}): GraphDelta => {
	const { prevState, nextState, keySlots, dirtySlots, affectedSlots, retargetedTokens } = args
	const removed: NodeKey[] = []
	const added: NodeKey[] = []
	const replaced = new Map<NodeKey, NodeKey>()

	for (let i = 0; i < dirtySlots.length; i++) {
		const slot = dirtySlots[i]!
		const before = draftDeclarationAt(prevState, slot)
		const after = draftDeclarationAt(nextState, slot)
		if (before && !after) removed.push(before.key)
		else if (!before && after) added.push(after.key)
		else if (before && after) {
			if (before.key !== after.key) replaced.set(before.key, after.key)
			else if (!declEqual(before, after)) replaced.set(after.key, after.key)
		}
	}

	const affected = new Set<NodeKey>()
	for (let i = 0; i < affectedSlots.length; i++) {
		const slot = affectedSlots[i]!
		const beforeKey = draftDeclarationAt(prevState, slot)?.key
		const afterKey = draftDeclarationAt(nextState, slot)?.key
		if (beforeKey !== undefined) affected.add(beforeKey)
		if (afterKey !== undefined) affected.add(afterKey)
	}

	for (const [fromSlot, toSlot] of nextState.replacementPairs) {
		const from = keySlots.keyAt(fromSlot)
		const to = keySlots.keyAt(toSlot)
		if (from === undefined || to === undefined) continue
		const removedIndex = removed.indexOf(from)
		if (removedIndex >= 0) removed.splice(removedIndex, 1)
		const addedIndex = added.indexOf(to)
		if (addedIndex >= 0) added.splice(addedIndex, 1)
		replaced.set(from, to)
	}

	return {
		added: cloneArray(added),
		removed: cloneArray(removed),
		replaced: cloneArray([...replaced.entries()].map(([from, to]) => ({ from, to }))),
		affected: cloneArray([...affected]),
		retargetedTokens: cloneArray(retargetedTokens),
	}
}

const buildIncrementalSnapshot = <M>(
	prev: GraphSnapshot<M>,
	prevState: DraftState<M>,
	nextState: DraftState<M>,
	keySlots: NodeKeySlotRegistry,
	dirty: ReadonlySet<Slot>,
	revision: number,
	scratch: BuildScratch,
): Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError> => {
	const issues: GraphBuildIssue[] = []
	const slotOfKey = (key: NodeKey): Slot | undefined => {
		const slot = keySlots.lookup(key)
		return slot !== undefined && draftDeclarationAt(nextState, slot)?.key === key ? slot : undefined
	}
	const keyOfSlot = (slot: Slot): NodeKey | undefined =>
		draftDeclarationAt(nextState, slot) ? keySlots.keyAt(slot) : undefined
	const dirtyMarks = scratch.dirtyMarks
	const dirtySlots = scratch.dirtySlots
	const affectedSlots = scratch.affectedSlots
	const affectedStack = scratch.affectedStack
	const changedDependentMarks = scratch.changedDependentMarks
	const changedDependentSlots = scratch.changedDependentSlots
	const changedOptionalDependentMarks = scratch.changedOptionalDependentMarks
	const changedOptionalDependentSlots = scratch.changedOptionalDependentSlots
	dirtySlots.length = 0
	affectedSlots.length = 0
	affectedStack.length = 0
	changedDependentSlots.length = 0
	changedOptionalDependentSlots.length = 0

	const touchedTokens = new Set<Token>()
	const reuseTokenOwnerSlots = canReuseTokenOwnerSlots(prevState, nextState, dirty)
	let tokenOwnerSlots: ReadonlyMap<Token, Slot>
	validateDirtyDeclarations(nextState, dirty, issues)
	if (reuseTokenOwnerSlots) {
		tokenOwnerSlots = prev.tokenOwnerSlots()
	} else {
		const mutableTokenOwnerSlots = new MutableTokenOwnerIndex(prev.tokenOwnerSlots())
		updateTokenOwnersForDirtySlots({
			prevState,
			nextState,
			dirty,
			tokenOwnerSlots: mutableTokenOwnerSlots,
			touchedTokens,
			slotOfKey,
			keyOfSlot,
			issues,
		})
		tokenOwnerSlots = mutableTokenOwnerSlots.finish()
	}

	const retargetedTokens = computeRetargetedTokens(
		touchedTokens,
		(token) => prev.resolve(token),
		(token) => {
			const slot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, token)
			return slot === undefined ? undefined : keyOfSlot(slot)
		},
	)
	collectAffectedSlots(prev, dirty, retargetedTokens, scratch)

	const previousTables = prev[graphSnapshotTables]()
	const previousIndexes = prev[graphSnapshotIndexes]()
	const declarationsBySlot = previousTables.declarations.mutate()
	const createsBySlot = previousTables.creates.mutate()
	const depsBySlot = previousTables.deps.mutate()
	const dependentsBySlot = previousTables.dependents.mutate()
	const optionalDepsBySlot = previousTables.optionalDeps.mutate()
	const optionalDependentsBySlot = previousTables.optionalDependents.mutate()
	let tokenConsumerSlots: MutableMapDeltaIndex<Token, readonly Slot[] | Slot[]> | undefined
	let optionalTokenConsumerSlots: MutableMapDeltaIndex<Token, readonly Slot[] | Slot[]> | undefined
	const changedTokenConsumers = new Set<Token>()
	const changedOptionalTokenConsumers = new Set<Token>()
	const ensureTokenConsumerSlotsMutable = () => {
		return (tokenConsumerSlots ??= new MutableMapDeltaIndex(previousIndexes.tokenConsumers))
	}
	const ensureOptionalTokenConsumerSlotsMutable = () => {
		return (optionalTokenConsumerSlots ??= new MutableMapDeltaIndex(
			previousIndexes.optionalTokenConsumers,
		))
	}

	for (const slot of affectedSlots) {
		const beforeDecl = draftDeclarationAt(prevState, slot)
		const afterDecl = draftDeclarationAt(nextState, slot)
		const beforeKey = beforeDecl?.key
		const afterKey = afterDecl?.key
		const beforeDepSlots = prev.depSlotsOf(slot)
		const beforeOptionalDepSlots = prev.optionalDepSlotsOf(slot)
		const declarationChanged = beforeKey !== afterKey || dirtyMarks.has(slot)
		const dependencyTokensChanged =
			!beforeDecl || !afterDecl || !shallowArrayEqual(beforeDecl.deps, afterDecl.deps)
		const optionalDependencyTokensChanged =
			!beforeDecl ||
			!afterDecl ||
			!shallowArrayEqual(beforeDecl.optionalDeps, afterDecl.optionalDeps)
		const hadNodeBefore = beforeKey !== undefined && beforeDecl !== undefined

		if (hadNodeBefore) {
			for (let i = 0; i < beforeDepSlots.length; i++) {
				removeFromMutableSlotTable(
					dependentsBySlot,
					beforeDepSlots[i]!,
					slot,
					changedDependentMarks,
					changedDependentSlots,
				)
			}
			for (let i = 0; i < beforeOptionalDepSlots.length; i++) {
				const dependencySlot = beforeOptionalDepSlots[i]!
				const dependents = optionalDependentsBySlot.get(dependencySlot)
				if (!dependents?.includes(slot)) continue
				removeFromMutableSlotTable(
					optionalDependentsBySlot,
					dependencySlot,
					slot,
					changedOptionalDependentMarks,
					changedOptionalDependentSlots,
				)
			}
			if (dependencyTokensChanged) {
				const consumers = ensureTokenConsumerSlotsMutable()
				for (const depToken of beforeDecl.deps) {
					removeFromMutableSlotListMap(consumers, depToken, slot, changedTokenConsumers)
				}
			}
			if (optionalDependencyTokensChanged) {
				for (const depToken of beforeDecl.optionalDeps) {
					const mutableConsumers = ensureOptionalTokenConsumerSlotsMutable()
					const consumers = mutableConsumers.get(depToken)
					if (!consumers?.includes(slot)) continue
					removeFromMutableSlotListMap(
						mutableConsumers,
						depToken,
						slot,
						changedOptionalTokenConsumers,
					)
				}
			}
		}

		if (!afterDecl || afterKey === undefined) {
			declarationsBySlot.set(slot, undefined)
			createsBySlot.set(slot, undefined)
			depsBySlot.set(slot, emptySlotArray)
			dependentsBySlot.set(slot, emptySlotArray)
			if ((optionalDepsBySlot.get(slot)?.length ?? 0) > 0)
				optionalDepsBySlot.set(slot, emptySlotArray)
			if ((optionalDependentsBySlot.get(slot)?.length ?? 0) > 0)
				optionalDependentsBySlot.set(slot, emptySlotArray)
			continue
		}

		const resolvedDeps: Slot[] = []
		for (const depToken of afterDecl.deps) {
			if (dependencyTokensChanged) {
				addToMutableSlotListMap(
					ensureTokenConsumerSlotsMutable(),
					depToken,
					slot,
					changedTokenConsumers,
				)
			}
			const depSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, depToken)
			if (depSlot === undefined) {
				issues.push({ kind: 'MissingDependency', nodeKey: afterKey, token: depToken })
				continue
			}
			resolvedDeps.push(depSlot)
			addToMutableSlotTable(
				dependentsBySlot,
				depSlot,
				slot,
				changedDependentMarks,
				changedDependentSlots,
			)
		}

		const currentDeclaration = declarationsBySlot.get(slot)
		declarationsBySlot.set(
			slot,
			declarationChanged || !currentDeclaration
				? createGraphDeclaration(afterDecl)
				: currentDeclaration,
		)
		const currentCreate = createsBySlot.get(slot)
		createsBySlot.set(slot, declarationChanged || !currentCreate ? afterDecl.create : currentCreate)
		depsBySlot.set(slot, finishArray(resolvedDeps))
		if (!dependentsBySlot.get(slot)) dependentsBySlot.set(slot, emptySlotArray)

		const resolvedOptionalDeps: Slot[] = []
		for (const depToken of afterDecl.optionalDeps) {
			if (optionalDependencyTokensChanged) {
				const mutableConsumers = ensureOptionalTokenConsumerSlotsMutable()
				const consumers = mutableConsumers.get(depToken)
				if (!consumers?.includes(slot)) {
					addToMutableSlotListMap(mutableConsumers, depToken, slot, changedOptionalTokenConsumers)
				}
			}
			const depSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotOfKey, depToken)
			if (depSlot === undefined) continue
			if (!resolvedOptionalDeps.includes(depSlot)) resolvedOptionalDeps.push(depSlot)
			const dependents = optionalDependentsBySlot.get(depSlot)
			if (!dependents?.includes(slot)) {
				addToMutableSlotTable(
					optionalDependentsBySlot,
					depSlot,
					slot,
					changedOptionalDependentMarks,
					changedOptionalDependentSlots,
				)
			}
		}
		const nextOptionalDeps = finishArray(resolvedOptionalDeps)
		if (!shallowArrayEqual(optionalDepsBySlot.get(slot) ?? emptySlotArray, nextOptionalDeps)) {
			optionalDepsBySlot.set(slot, nextOptionalDeps)
		}
	}

	if (issues.length === 0) {
		const color = new SlotColors()
		const stack: Slot[] = []
		const stackIndex = new Map<Slot, number>()
		for (const slot of affectedSlots) {
			if (declarationsBySlot.get(slot) === undefined || color.has(slot)) continue
			visitCycleSlots(
				slot,
				(current) =>
					mergeUniqueSlots(
						depsBySlot.get(current) ?? emptySlotArray,
						optionalDepsBySlot.get(current) ?? emptySlotArray,
					),
				(current) => declarationsBySlot.get(current) !== undefined,
				(current) => keyOfSlot(current),
				color,
				stack,
				stackIndex,
				issues,
			)
		}
	}

	if (issues.length > 0) return err(new GraphBuildError(issues))

	for (let i = 0; i < changedDependentSlots.length; i++) {
		const slot = changedDependentSlots[i]!
		const dependents = dependentsBySlot.get(slot)
		if (!dependents) {
			dependentsBySlot.set(slot, emptySlotArray)
			continue
		}
		dependentsBySlot.set(slot, finishArray(dependents as Slot[]))
	}
	for (let i = 0; i < changedOptionalDependentSlots.length; i++) {
		const slot = changedOptionalDependentSlots[i]!
		const optionalDependents = optionalDependentsBySlot.get(slot)
		optionalDependentsBySlot.set(
			slot,
			optionalDependents ? finishArray(optionalDependents as Slot[]) : emptySlotArray,
		)
	}

	return ok({
		graph: new GraphSnapshot<M>({
			revision,
			activeCount: nextState.activeCount,
			keySlots,
			slotCount: nextState.slotLimit,
			declarationsBySlot: declarationsBySlot.finish(nextState.slotLimit),
			createsBySlot: createsBySlot.finish(nextState.slotLimit),
			depsBySlot: depsBySlot.finish(nextState.slotLimit),
			dependentsBySlot: dependentsBySlot.finish(nextState.slotLimit),
			optionalDepsBySlot: optionalDepsBySlot.finish(),
			optionalDependentsBySlot: optionalDependentsBySlot.finish(),
			tokenOwnerSlots,
			tokenConsumerSlots: tokenConsumerSlots
				? finalizeChangedTokenConsumerSlots(tokenConsumerSlots, changedTokenConsumers)
				: previousIndexes.tokenConsumers,
			optionalTokenConsumerSlots: optionalTokenConsumerSlots
				? finalizeChangedTokenConsumerSlots(
						optionalTokenConsumerSlots,
						changedOptionalTokenConsumers,
					)
				: previousIndexes.optionalTokenConsumers,
		}),
		delta: collectGraphDelta({
			prevState,
			nextState,
			keySlots,
			dirtySlots,
			affectedSlots,
			retargetedTokens,
		}),
	})
}

export const classProvider = <T, M = unknown>(
	input: Omit<ProviderDecl<T, M>, 'create'> & { use: new (...args: any[]) => T },
): ProviderDecl<T, M> => ({
	key: input.key,
	tokens: input.tokens,
	deps: input.deps,
	optionalDeps: input.optionalDeps,
	cache: input.cache,
	meta: input.meta,
	create: { kind: 'class', value: input.use },
})

export const factoryProvider = <T, M = unknown>(
	input: Omit<ProviderDecl<T, M>, 'create'> & { use: (...deps: readonly unknown[]) => T },
): ProviderDecl<T, M> => ({
	key: input.key,
	tokens: input.tokens,
	deps: input.deps,
	optionalDeps: input.optionalDeps,
	cache: input.cache,
	meta: input.meta,
	create: { kind: 'factory', value: input.use },
})

export const valueProvider = <T, M = unknown>(
	input: Omit<ProviderDecl<T, M>, 'create'> & { use: T },
): ProviderDecl<T, M> => ({
	key: input.key,
	tokens: input.tokens,
	deps: input.deps,
	optionalDeps: input.optionalDeps,
	cache: input.cache,
	meta: input.meta,
	create: { kind: 'value', value: input.use },
})

export class DraftGraph<M = unknown> {
	private readonly keySlots = new NodeKeySlotRegistry()
	private committedState = createDraftState<M>()
	private draftState = createDraftState<M>()
	private readonly sealedDraftStates = new WeakSet<DraftState<M>>()
	private dirty = new Set<Slot>()
	private readonly buildScratch = createBuildScratch()
	private mutationVersion = 0
	private previewCache?: PreviewCache<M>
	private planningCache?: PlanningCache<M>
	private committedGraph = GraphSnapshot.empty<M>(this.keySlots)
	public readonly instances = new InstanceStore<NodeKey, unknown>()

	public get graph(): GraphSnapshot<M> {
		return this.committedGraph
	}

	public has(nodeKey: NodeKey): boolean {
		const slot = this.keySlots.lookup(nodeKey)
		return slot !== undefined && draftDeclarationAt(this.draftState, slot)?.key === nodeKey
	}

	public planningDeclaration(nodeKey: NodeKey): GraphDeclaration<M> | undefined {
		const slot = this.keySlots.lookup(nodeKey)
		if (slot === undefined) return undefined
		const declaration = draftDeclarationAt(this.draftState, slot)
		return declaration ? createGraphDeclaration(declaration) : undefined
	}

	public hasPendingChanges(): boolean {
		return this.dirty.size > 0
	}

	private invalidatePreviewCache(): void {
		this.previewCache = undefined
		this.planningCache = undefined
	}

	private planningState(): PlanningCache<M> {
		const builtAtVersion = this.mutationVersion
		const builtState = this.draftState
		const cached = this.planningCache
		if (cached && cached.builtAtVersion === builtAtVersion && cached.builtState === builtState) {
			return cached
		}

		const providerSlotsByToken = new Map<Token, Slot[]>()
		const consumerSlotsByToken = new Map<Token, Slot[]>()

		for (const slot of this.dirty) {
			const decl = draftDeclarationAt(builtState, slot)
			if (!decl) continue
			for (const token of decl.tokens) {
				addToSlotListMap(providerSlotsByToken, token, slot)
			}
			for (const depToken of decl.deps) {
				addToSlotListMap(consumerSlotsByToken, depToken, slot)
			}
		}

		const planning: PlanningCache<M> = {
			builtAtVersion,
			builtState,
			providerSlotsByToken,
			consumerSlotsByToken,
		}
		this.planningCache = planning
		return planning
	}

	private resolvePlanningTokenSlot(
		token: Token,
		planning = this.planningState(),
	): Slot | undefined {
		const providers = this.planningProviderSlots(token, planning)
		return providers.length === 1 ? providers[0] : undefined
	}

	private planningProviderSlots(token: Token, planning: PlanningCache<M>): readonly Slot[] {
		const providers = new Set<Slot>()
		const committed = this.committedGraph.resolveSlot(token)
		if (committed !== undefined) {
			const declaration = draftDeclarationAt(planning.builtState, committed)
			if (declaration?.tokens.includes(token)) providers.add(committed)
		}
		if (isDefaultTokenCandidate(token)) {
			const self = this.keySlots.lookup(token as NodeKey)
			if (self !== undefined && draftDeclarationAt(planning.builtState, self)?.key === token) {
				providers.add(self)
			}
		}
		for (const slot of planning.providerSlotsByToken.get(token) ?? emptySlotArray) {
			if (draftDeclarationAt(planning.builtState, slot)?.tokens.includes(token)) providers.add(slot)
		}
		return [...providers]
	}

	private planningConsumerSlots(token: Token, planning: PlanningCache<M>): readonly Slot[] {
		const consumers = new Set<Slot>()
		for (const slot of this.committedGraph.tokenConsumerSlotsOf(token)) {
			if (draftDeclarationAt(planning.builtState, slot)?.deps.includes(token)) consumers.add(slot)
		}
		for (const slot of planning.consumerSlotsByToken.get(token) ?? emptySlotArray) {
			if (draftDeclarationAt(planning.builtState, slot)?.deps.includes(token)) consumers.add(slot)
		}
		return [...consumers]
	}

	public resolvePlanningToken(token: Token): NodeKey | undefined {
		const planning = this.planningState()
		const slot = this.resolvePlanningTokenSlot(token, planning)
		return slot === undefined ? undefined : this.keySlots.keyAt(slot)
	}

	public collectCascadeTargets(handle: NodeKey | Token): Set<NodeKey> {
		return this.collectCascadeTargetsFrom([handle])
	}

	/** Collect the union closure for all roots in one traversal. */
	public collectCascadeTargetsFrom(handles: Iterable<NodeKey | Token>): Set<NodeKey> {
		if (this.dirty.size === 0) {
			const graph = this.committedGraph
			const pending: Slot[] = []
			const visited = new Set<Slot>()
			const affected = new Set<NodeKey>()
			const queue = (slot: Slot | undefined) => {
				if (slot === undefined || visited.has(slot)) return
				visited.add(slot)
				pending.push(slot)
			}
			for (const handle of handles) {
				queue(graph.slotOf(handle as NodeKey))
				if (isDefaultTokenCandidate(handle as NodeKey)) queue(graph.resolveSlot(handle as Token))
			}
			while (pending.length > 0) {
				const slot = pending.pop()!
				const key = graph.keyOf(slot)
				if (key !== undefined) affected.add(key)
				for (const dependent of graph.dependentSlotsOf(slot)) queue(dependent)
			}
			return affected
		}

		const planning = this.planningState()
		const slotMarks = new Set<Slot>()
		const tokenMarks = new Set<Token>()
		const pendingSlots: Slot[] = []
		const pendingTokens: Token[] = []
		const affected = new Set<NodeKey>()

		const queueSlot = (slot: Slot | undefined) => {
			if (slot === undefined || slot < 0 || slot >= planning.builtState.slotLimit) return
			if (slotMarks.has(slot)) return
			slotMarks.add(slot)
			pendingSlots.push(slot)
		}
		const queueToken = (token: Token) => {
			if (tokenMarks.has(token)) return
			tokenMarks.add(token)
			pendingTokens.push(token)
		}

		for (const handle of handles) {
			const handleSlot = this.keySlots.lookup(handle as NodeKey)
			queueSlot(
				handleSlot !== undefined &&
					draftDeclarationAt(planning.builtState, handleSlot)?.key === handle
					? handleSlot
					: undefined,
			)
			if (isDefaultTokenCandidate(handle as NodeKey)) {
				const token = handle as Token
				queueSlot(this.resolvePlanningTokenSlot(token, planning))
				queueToken(token)
			}
		}

		while (pendingSlots.length > 0 || pendingTokens.length > 0) {
			while (pendingSlots.length > 0) {
				const slot = pendingSlots.pop()!
				const decl = draftDeclarationAt(planning.builtState, slot)
				if (!decl) continue
				affected.add(decl.key)
				for (let i = 0; i < decl.tokens.length; i++) queueToken(decl.tokens[i]!)
			}

			while (pendingTokens.length > 0) {
				const token = pendingTokens.pop()!
				for (const provider of this.planningProviderSlots(token, planning)) queueSlot(provider)
				for (const consumer of this.planningConsumerSlots(token, planning)) queueSlot(consumer)
			}
		}

		return affected
	}

	private ensureMutableDraftState() {
		if (this.draftState !== this.committedState && !this.sealedDraftStates.has(this.draftState)) {
			return
		}
		this.draftState = cloneDraftState(this.draftState)
	}

	private writeNormalized(
		state: DraftState<M>,
		normalized: NormalizedProviderDecl<unknown, M>,
	): Slot | undefined {
		const slot = this.keySlots.intern(normalized.key)
		const current = draftDeclarationAt(state, slot)
		if (current?.key === normalized.key && declEqual(current, normalized)) {
			return undefined
		}
		if (!current) {
			const source = state.replacementSources.pop()
			if (source !== undefined && source !== slot) state.replacementPairs.set(source, slot)
		}
		setDraftDeclaration(state, slot, normalized)
		return slot
	}

	private releaseSlot(state: DraftState<M>, slot: Slot, key: NodeKey): void {
		const current = draftDeclarationAt(state, slot)
		if (!current || current.key !== key) return
		setDraftDeclaration(state, slot, undefined)
		let restoredSource: Slot | undefined
		for (const [source, target] of state.replacementPairs) {
			if (target !== slot) continue
			state.replacementPairs.delete(source)
			restoredSource = source
			break
		}
		if (restoredSource !== undefined) state.replacementSources.push(restoredSource)
		else if (state.base.get(slot) !== undefined) state.replacementSources.push(slot)
	}

	public put<T>(decl: ProviderDecl<T, M>): void {
		this.ensureMutableDraftState()
		this.invalidatePreviewCache()
		const state = this.draftState
		const normalized = normalizeDecl(decl)
		const slot = this.writeNormalized(state, normalized)
		if (slot === undefined) return
		this.dirty.add(slot)
		this.mutationVersion += 1
	}

	public replace<T>(fromKey: NodeKey, decl: ProviderDecl<T, M>): void {
		this.ensureMutableDraftState()
		this.invalidatePreviewCache()
		const state = this.draftState
		const normalized = normalizeDecl(decl)
		if (fromKey === normalized.key) {
			const slot = this.writeNormalized(state, normalized)
			if (slot === undefined) return
			this.dirty.add(slot)
			this.mutationVersion += 1
			return
		}

		const fromSlot = this.keySlots.lookup(fromKey)
		if (fromSlot === undefined || draftDeclarationAt(state, fromSlot)?.key !== fromKey) {
			const slot = this.writeNormalized(state, normalized)
			if (slot === undefined) return
			this.dirty.add(slot)
			this.mutationVersion += 1
			return
		}

		const existingTargetSlot = this.keySlots.lookup(normalized.key)
		if (
			existingTargetSlot !== undefined &&
			existingTargetSlot !== fromSlot &&
			draftDeclarationAt(state, existingTargetSlot)?.key === normalized.key
		) {
			this.releaseSlot(state, existingTargetSlot, normalized.key)
			this.dirty.add(existingTargetSlot)
		}

		this.releaseSlot(state, fromSlot, fromKey)
		const toSlot = this.keySlots.intern(normalized.key)
		const sourceIndex = state.replacementSources.lastIndexOf(fromSlot)
		if (sourceIndex >= 0) state.replacementSources.splice(sourceIndex, 1)
		setDraftDeclaration(state, toSlot, normalized)
		state.replacementPairs.set(fromSlot, toSlot)
		this.dirty.add(fromSlot)
		this.dirty.add(toSlot)
		this.mutationVersion += 1
	}

	public remove(nodeKey: NodeKey): boolean {
		this.ensureMutableDraftState()
		this.invalidatePreviewCache()
		const state = this.draftState
		const slot = this.keySlots.lookup(nodeKey)
		if (slot === undefined || draftDeclarationAt(state, slot)?.key !== nodeKey) return false
		this.releaseSlot(state, slot, nodeKey)
		this.dirty.add(slot)
		this.mutationVersion += 1
		return true
	}

	public reset(): void {
		this.invalidatePreviewCache()
		this.draftState = this.committedState
		this.dirty.clear()
		this.mutationVersion += 1
	}

	private createBuildArtifact(
		graph: GraphSnapshot<M>,
		delta: GraphDelta,
		commit: () => GraphSnapshot<M>,
	): GraphBuild<M> {
		let runtime: Runtime<M> | undefined
		return {
			graph,
			delta,
			instances: this.instances,
			get runtime() {
				runtime ??= new Runtime(graph, this.instances)
				return runtime
			},
			commit,
			reset: () => this.reset(),
		}
	}

	private emptyDelta(): GraphDelta {
		return {
			added: cloneArray([]),
			removed: cloneArray([]),
			replaced: cloneArray([]),
			affected: cloneArray([]),
			retargetedTokens: cloneArray([]),
		}
	}

	private dirtySlotsForBuild(builtState: DraftState<M>): Set<Slot> {
		return builtState === this.committedState ? new Set() : new Set(this.dirty)
	}

	private buildSnapshotFromState(
		builtState: DraftState<M>,
		dirty: ReadonlySet<Slot>,
	): Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError> {
		if (this.committedGraph.revision === 0) {
			const nextGraphResult = buildFullSnapshot(
				builtState,
				this.keySlots,
				this.committedGraph.revision + 1,
			)
			if (nextGraphResult.ok === false) return err(nextGraphResult.err)
			const active = activeKeysOfState(builtState)
			return ok({
				graph: nextGraphResult.val,
				delta: {
					added: active,
					removed: cloneArray([]),
					replaced: cloneArray([]),
					affected: active,
					retargetedTokens: cloneArray([]),
				},
			})
		}

		const nextGraphResult = (() => {
			try {
				return buildIncrementalSnapshot(
					this.committedGraph,
					this.committedState,
					builtState,
					this.keySlots,
					dirty,
					this.committedGraph.revision + 1,
					this.buildScratch,
				)
			} finally {
				resetBuildScratch(this.buildScratch)
			}
		})()
		if (nextGraphResult.ok === false) return err(nextGraphResult.err)
		return ok(nextGraphResult.val)
	}

	private commitBuiltState(
		builtState: DraftState<M>,
		nextGraph: GraphSnapshot<M>,
		delta: GraphDelta,
		builtAtVersion: number,
	): GraphSnapshot<M> {
		this.invalidatePreviewCache()
		this.instances.deleteMany(delta.removed)
		this.instances.deleteMany(delta.replaced.map(({ from }) => from))
		this.committedGraph = nextGraph
		this.committedState = finishDraftState(builtState)
		if (builtAtVersion === this.mutationVersion) {
			this.draftState = this.committedState
			this.dirty.clear()
		} else {
			this.dirty = computeDirtySlots(this.committedState, this.draftState)
		}
		return nextGraph
	}

	public preview(): Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError> {
		if (this.dirty.size === 0) {
			return ok({ graph: this.committedGraph, delta: this.emptyDelta() })
		}

		const builtAtVersion = this.mutationVersion
		const builtState = this.draftState
		const cached = this.previewCache
		if (cached && cached.builtAtVersion === builtAtVersion && cached.builtState === builtState) {
			return cached.result
		}

		const dirty = this.dirtySlotsForBuild(builtState)
		const result = this.buildSnapshotFromState(builtState, dirty)
		if (result.ok) this.sealedDraftStates.add(builtState)
		this.previewCache = { builtAtVersion, builtState, result }
		return result
	}

	public build(): Result<GraphBuild<M>, GraphBuildError> {
		const builtAtVersion = this.mutationVersion
		if (this.dirty.size === 0) {
			const graph = this.committedGraph
			return ok(
				this.createBuildArtifact(graph, this.emptyDelta(), () => {
					if (builtAtVersion === this.mutationVersion) this.dirty.clear()
					return this.committedGraph
				}),
			)
		}

		const builtState = this.draftState
		const built = this.preview()
		if (built.ok === false) return err(built.err)
		return ok(
			this.createBuildArtifact(built.val.graph, built.val.delta, () =>
				this.commitBuiltState(builtState, built.val.graph, built.val.delta, builtAtVersion),
			),
		)
	}
}
