import { GraphBuildError, type GraphBuildIssue } from './errors'
import { InstanceStore } from './InstanceStore'
import { err, ok, type Result } from './result'

export type Token = string | symbol | Function
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
	cache?: CachePolicy
	meta?: M
	create: ProviderCreate<T>
}

type NormalizedProviderDecl<T = unknown, M = unknown> = {
	key: NodeKey
	explicitTokens: readonly Token[]
	tokens: readonly Token[]
	deps: readonly Token[]
	cache: CachePolicy
	meta: M | undefined
	create: ProviderCreate<T>
}

export type GraphDeclaration<M = unknown> = {
	key: NodeKey
	tokens: readonly Token[]
	depTokens: readonly Token[]
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
type BuildScratch = {
	dirtyMarks: Uint8Array
	affectedMarks: Uint8Array
	changedDependentMarks: Uint8Array
	dirtySlots: Slot[]
	affectedSlots: Slot[]
	affectedStack: Slot[]
	changedDependentSlots: Slot[]
}
type DraftState<M = unknown> = {
	slotByKey: Map<NodeKey, Slot>
	keyBySlot: (NodeKey | undefined)[]
	declsBySlot: Array<NormalizedProviderDecl<unknown, M> | undefined>
	freeSlots: Slot[]
}
type PreviewCache<M = unknown> = {
	builtAtVersion: number
	builtState: DraftState<M>
	result: Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError>
}
type PlanningCache<M = unknown> = {
	builtAtVersion: number
	builtState: DraftState<M>
	explicitTokenOwnerSlots: ReadonlyMap<Token, Slot | null>
	providerSlotsByToken: ReadonlyMap<Token, readonly Slot[]>
	consumerSlotsByToken: ReadonlyMap<Token, readonly Slot[]>
}

const emptyArray: readonly unknown[] = []
const emptySlotArray: readonly Slot[] = []

const cloneArray = <T>(value: readonly T[]): readonly T[] =>
	value.length === 0 ? (emptyArray as readonly T[]) : [...value]

const finishArray = <T>(value: T[]): readonly T[] =>
	value.length === 0 ? (emptyArray as readonly T[]) : value

const shallowArrayEqual = (a: readonly unknown[], b: readonly unknown[]): boolean => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

const isDefaultTokenCandidate = (value: NodeKey): value is Token =>
	typeof value === 'string' || typeof value === 'symbol' || typeof value === 'function'

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
	shallowArrayEqual(a.deps, b.deps)

const createDraftState = <M>(): DraftState<M> => ({
	slotByKey: new Map(),
	keyBySlot: [],
	declsBySlot: [],
	freeSlots: [],
})

const createBuildScratch = (length: number): BuildScratch => ({
	dirtyMarks: new Uint8Array(length),
	affectedMarks: new Uint8Array(length),
	changedDependentMarks: new Uint8Array(length),
	dirtySlots: [],
	affectedSlots: [],
	affectedStack: [],
	changedDependentSlots: [],
})

const ensureBuildScratch = (scratch: BuildScratch, length: number): BuildScratch => {
	if (scratch.dirtyMarks.length < length) return createBuildScratch(length)
	return scratch
}

const resetBuildScratch = (scratch: BuildScratch): void => {
	for (let i = 0; i < scratch.dirtySlots.length; i++) {
		scratch.dirtyMarks[scratch.dirtySlots[i]!] = 0
	}
	for (let i = 0; i < scratch.affectedSlots.length; i++) {
		scratch.affectedMarks[scratch.affectedSlots[i]!] = 0
	}
	for (let i = 0; i < scratch.changedDependentSlots.length; i++) {
		scratch.changedDependentMarks[scratch.changedDependentSlots[i]!] = 0
	}
	scratch.dirtySlots.length = 0
	scratch.affectedSlots.length = 0
	scratch.affectedStack.length = 0
	scratch.changedDependentSlots.length = 0
}

const activeKeysOfState = <M>(state: DraftState<M>): readonly NodeKey[] => {
	const out: NodeKey[] = []
	for (let slot = 0; slot < state.declsBySlot.length; slot++) {
		const decl = state.declsBySlot[slot]
		if (decl !== undefined) out.push(decl.key)
	}
	return finishArray(out)
}

const cloneDraftState = <M>(state: DraftState<M>): DraftState<M> => ({
	slotByKey: new Map(state.slotByKey),
	keyBySlot: state.keyBySlot.slice(),
	declsBySlot: state.declsBySlot.slice(),
	freeSlots: state.freeSlots.slice(),
})

const computeDirtySlots = <M>(base: DraftState<M>, draft: DraftState<M>): Set<Slot> => {
	const dirty = new Set<Slot>()
	const length = Math.max(base.declsBySlot.length, draft.declsBySlot.length)
	for (let slot = 0; slot < length; slot++) {
		const baseDecl = base.declsBySlot[slot]
		const draftDecl = draft.declsBySlot[slot]
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
	cache: decl.cache,
	meta: decl.meta,
	providerKind: decl.create.kind,
})

const resolveTokenSlotFromTable = (
	tokenOwnerSlots: ReadonlyMap<Token, Slot>,
	slotByKey: ReadonlyMap<NodeKey, Slot>,
	token: Token,
): Slot | undefined =>
	tokenOwnerSlots.get(token) ??
	(isDefaultTokenCandidate(token) ? slotByKey.get(token as NodeKey) : undefined)

const addToMutableSlotListMap = <K>(
	map: Map<K, readonly Slot[] | Slot[]>,
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
	map: Map<K, readonly Slot[] | Slot[]>,
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

const markSlot = (marks: Uint8Array, slots: Slot[], slot: Slot): boolean => {
	if (!Number.isInteger(slot) || slot < 0 || slot >= marks.length) return false
	if (marks[slot] === 1) return false
	marks[slot] = 1
	slots.push(slot)
	return true
}

const ensureMutableSlotList = (
	table: Array<readonly Slot[] | Slot[] | undefined>,
	slot: Slot,
	mutatedMarks: Uint8Array,
	mutatedSlots: Slot[],
): Slot[] => {
	const current = table[slot]
	if (!current) {
		const created: Slot[] = []
		table[slot] = created
		markSlot(mutatedMarks, mutatedSlots, slot)
		return created
	}
	if (mutatedMarks[slot] === 1) return current as Slot[]
	const next = [...current]
	table[slot] = next
	markSlot(mutatedMarks, mutatedSlots, slot)
	return next
}

const addToMutableSlotTable = (
	table: Array<readonly Slot[] | Slot[] | undefined>,
	slot: Slot,
	value: Slot,
	mutatedMarks: Uint8Array,
	mutatedSlots: Slot[],
) => {
	const next = ensureMutableSlotList(table, slot, mutatedMarks, mutatedSlots)
	if (!next.includes(value)) next.push(value)
}

const removeFromMutableSlotTable = (
	table: Array<readonly Slot[] | Slot[] | undefined>,
	slot: Slot,
	value: Slot,
	mutatedMarks: Uint8Array,
	mutatedSlots: Slot[],
) => {
	const current = table[slot]
	if (!current) return
	const next = ensureMutableSlotList(table, slot, mutatedMarks, mutatedSlots)
	const idx = next.indexOf(value)
	if (idx < 0) return
	next.splice(idx, 1)
	if (next.length === 0) table[slot] = emptySlotArray
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
	color: Uint8Array,
	stack: Slot[],
	stackIndex: Map<Slot, number>,
	issues: GraphBuildIssue[],
) => {
	const seen = color[slot] ?? 0
	if (seen === 2) return
	if (seen === 1) {
		const idx = stackIndex.get(slot) ?? -1
		const cycleSlots = idx >= 0 ? [...stack.slice(idx), slot] : [...stack, slot]
		const chain: NodeKey[] = []
		for (let i = 0; i < cycleSlots.length; i++) {
			const key = keyOf(cycleSlots[i]!)
			if (key !== undefined) chain.push(key)
		}
		if (chain.length > 0) issues.push({ kind: 'CircularDependency', chain })
		return
	}
	color[slot] = 1
	stackIndex.set(slot, stack.length)
	stack.push(slot)
	for (const dep of depsOf(slot)) {
		if (!exists(dep)) continue
		visitCycleSlots(dep, depsOf, exists, keyOf, color, stack, stackIndex, issues)
	}
	stack.pop()
	stackIndex.delete(slot)
	color[slot] = 2
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

export class GraphSnapshot<M = unknown> {
	public readonly revision: number
	private readonly activeNodeCount: number
	private readonly slotByKeyMap: ReadonlyMap<NodeKey, Slot>
	private readonly keyBySlotTable: readonly (NodeKey | undefined)[]
	private readonly declarationsBySlotTable: readonly (GraphDeclaration<M> | undefined)[]
	private readonly createsBySlotTable: readonly (ProviderCreate<unknown> | undefined)[]
	private readonly depsBySlotTable: readonly (readonly Slot[] | undefined)[]
	private readonly dependentsBySlotTable: readonly (readonly Slot[] | undefined)[]
	private readonly tokenOwnerSlotMap: ReadonlyMap<Token, Slot>
	private readonly tokenConsumerSlotsMap: ReadonlyMap<Token, readonly Slot[]>
	private readonly activatorsBySlot: Array<Activator | undefined> = []
	private readonly depsKeysCache: Array<readonly NodeKey[] | undefined> = []
	private readonly dependentsKeysCache: Array<readonly NodeKey[] | undefined> = []

	public constructor(args: {
		revision: number
		slotByKey: ReadonlyMap<NodeKey, Slot>
		keyBySlot: readonly (NodeKey | undefined)[]
		declarationsBySlot: readonly (GraphDeclaration<M> | undefined)[]
		createsBySlot: readonly (ProviderCreate<unknown> | undefined)[]
		depsBySlot: readonly (readonly Slot[] | undefined)[]
		dependentsBySlot: readonly (readonly Slot[] | undefined)[]
		tokenOwnerSlots: ReadonlyMap<Token, Slot>
		tokenConsumerSlots: ReadonlyMap<Token, readonly Slot[]>
	}) {
		this.revision = args.revision
		this.slotByKeyMap = args.slotByKey
		this.keyBySlotTable = args.keyBySlot
		this.declarationsBySlotTable = args.declarationsBySlot
		this.createsBySlotTable = args.createsBySlot
		this.depsBySlotTable = args.depsBySlot
		this.dependentsBySlotTable = args.dependentsBySlot
		this.tokenOwnerSlotMap = args.tokenOwnerSlots
		this.tokenConsumerSlotsMap = args.tokenConsumerSlots
		let activeNodeCount = 0
		for (let slot = 0; slot < this.declarationsBySlotTable.length; slot++) {
			if (this.declarationsBySlotTable[slot] !== undefined) activeNodeCount += 1
		}
		this.activeNodeCount = activeNodeCount
	}

	public static empty<M = unknown>(): GraphSnapshot<M> {
		return new GraphSnapshot<M>({
			revision: 0,
			slotByKey: new Map(),
			keyBySlot: [],
			declarationsBySlot: [],
			createsBySlot: [],
			depsBySlot: [],
			dependentsBySlot: [],
			tokenOwnerSlots: new Map(),
			tokenConsumerSlots: new Map(),
		})
	}

	public resolve(token: Token): NodeKey | undefined {
		const slot = this.resolveSlot(token)
		return slot === undefined ? undefined : this.keyBySlotTable[slot]
	}

	public resolveSlot(token: Token): Slot | undefined {
		return (
			this.tokenOwnerSlotMap.get(token) ??
			(isDefaultTokenCandidate(token) ? this.slotByKeyMap.get(token as NodeKey) : undefined)
		)
	}

	public has(nodeKey: NodeKey): boolean {
		return this.slotByKeyMap.has(nodeKey)
	}

	public declaration(nodeKey: NodeKey): GraphDeclaration<M> | undefined {
		const slot = this.slotByKeyMap.get(nodeKey)
		return slot === undefined ? undefined : this.declarationsBySlotTable[slot]
	}

	public depsOf(nodeKey: NodeKey): readonly NodeKey[] {
		const slot = this.slotByKeyMap.get(nodeKey)
		return slot === undefined ? (emptyArray as readonly NodeKey[]) : this.depsOfSlot(slot)
	}

	public dependentsOf(nodeKey: NodeKey): readonly NodeKey[] {
		const slot = this.slotByKeyMap.get(nodeKey)
		return slot === undefined ? (emptyArray as readonly NodeKey[]) : this.dependentsOfSlot(slot)
	}

	public consumers(token: Token): readonly NodeKey[] {
		const slots = this.tokenConsumerSlotsMap.get(token)
		return slots ? this.mapSlotsToKeys(slots) : (emptyArray as readonly NodeKey[])
	}

	public activatorAtSlot(slot: Slot): Activator {
		return this.activatorBySlot(slot)
	}

	public *keys(): IterableIterator<NodeKey> {
		for (let slot = 0; slot < this.keyBySlotTable.length; slot++) {
			const key = this.keyBySlotTable[slot]
			if (key !== undefined && this.declarationsBySlotTable[slot] !== undefined) yield key
		}
	}

	public slotOf(nodeKey: NodeKey): Slot | undefined {
		return this.slotByKeyMap.get(nodeKey)
	}

	public keyOf(slot: Slot): NodeKey | undefined {
		return this.keyBySlotTable[slot]
	}

	public slotCount(): number {
		return this.keyBySlotTable.length
	}

	public activeCount(): number {
		return this.activeNodeCount
	}

	public declarationAtSlot(slot: Slot): GraphDeclaration<M> | undefined {
		return this.declarationsBySlotTable[slot]
	}

	public depSlotsOf(slot: Slot): readonly Slot[] {
		return this.depsBySlotTable[slot] ?? emptySlotArray
	}

	public dependentSlotsOf(slot: Slot): readonly Slot[] {
		return this.dependentsBySlotTable[slot] ?? emptySlotArray
	}

	public tokenConsumerSlotsOf(token: Token): readonly Slot[] {
		return this.tokenConsumerSlotsMap.get(token) ?? emptySlotArray
	}

	public tokenOwnerSlots(): ReadonlyMap<Token, Slot> {
		return this.tokenOwnerSlotMap
	}

	public tokenConsumerSlots(): ReadonlyMap<Token, readonly Slot[]> {
		return this.tokenConsumerSlotsMap
	}

	public declarationsBySlot(): readonly (GraphDeclaration<M> | undefined)[] {
		return this.declarationsBySlotTable
	}

	public createsBySlot(): readonly (ProviderCreate<unknown> | undefined)[] {
		return this.createsBySlotTable
	}

	public depsBySlot(): readonly (readonly Slot[] | undefined)[] {
		return this.depsBySlotTable
	}

	public dependentsBySlot(): readonly (readonly Slot[] | undefined)[] {
		return this.dependentsBySlotTable
	}

	private depsOfSlot(slot: Slot): readonly NodeKey[] {
		const cached = this.depsKeysCache[slot]
		if (cached) return cached
		const mapped = this.mapSlotsToKeys(this.depsBySlotTable[slot] ?? emptySlotArray)
		this.depsKeysCache[slot] = mapped
		return mapped
	}

	private dependentsOfSlot(slot: Slot): readonly NodeKey[] {
		const cached = this.dependentsKeysCache[slot]
		if (cached) return cached
		const mapped = this.mapSlotsToKeys(this.dependentsBySlotTable[slot] ?? emptySlotArray)
		this.dependentsKeysCache[slot] = mapped
		return mapped
	}

	private activatorBySlot(slot: Slot): Activator {
		const cached = this.activatorsBySlot[slot]
		if (cached) return cached
		const create = this.createsBySlotTable[slot]
		if (!create) throw new Error('Unknown node key')
		const activator = compileActivator(create, this.depsBySlotTable[slot] ?? emptySlotArray)
		this.activatorsBySlot[slot] = activator
		return activator
	}

	private mapSlotsToKeys(slots: readonly Slot[]): readonly NodeKey[] {
		if (slots.length === 0) return emptyArray as readonly NodeKey[]
		const out: NodeKey[] = []
		for (let i = 0; i < slots.length; i++) {
			const key = this.keyBySlotTable[slots[i]!]
			if (key !== undefined) out.push(key)
		}
		return out.length === 0 ? (emptyArray as readonly NodeKey[]) : out
	}
}

export class Runtime<M = unknown> {
	private readonly resolvingMarks: Uint8Array
	private readonly retainedValues: unknown[] = []
	private readonly retainedRevisions: number[] = []
	private readonly retainedStoreRevisions: number[] = []
	private retainedKnown: Uint8Array

	public constructor(
		public readonly graph: GraphSnapshot<M>,
		public readonly instances: InstanceStore<NodeKey, unknown> = new InstanceStore(),
	) {
		this.resolvingMarks = new Uint8Array(graph.slotCount())
		this.retainedKnown = new Uint8Array(graph.slotCount())
	}

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
	revision: number,
): Result<GraphSnapshot<M>, GraphBuildError> => {
	const issues: GraphBuildIssue[] = []
	const { slotByKey, keyBySlot, declsBySlot: normalizedBySlot } = state
	const declarationsBySlot: Array<GraphDeclaration<M> | undefined> = []
	const createsBySlot: Array<ProviderCreate<unknown> | undefined> = []
	for (let slot = 0; slot < normalizedBySlot.length; slot++) {
		const decl = normalizedBySlot[slot]
		if (!decl) continue
		declarationsBySlot[slot] = createGraphDeclaration(decl)
		createsBySlot[slot] = decl.create
	}

	const tokenOwnerSlots = new Map<Token, Slot>()
	for (let slot = 0; slot < normalizedBySlot.length; slot++) {
		const decl = normalizedBySlot[slot]
		if (!decl) continue
		if (decl.create.kind === 'value' && decl.deps.length > 0) {
			issues.push({
				kind: 'InvalidDeclaration',
				nodeKey: decl.key,
				message: 'value providers can not declare dependencies',
			})
		}
		for (const token of decl.explicitTokens) {
			const ownerSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotByKey, token)
			if (ownerSlot === undefined || ownerSlot === slot) tokenOwnerSlots.set(token, slot)
			else {
				const ownerKey = keyBySlot[ownerSlot]
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

	const depsBySlot: Array<readonly Slot[] | undefined> = Array(keyBySlot.length)
	const dependentsBySlot: Array<readonly Slot[] | undefined> = Array(keyBySlot.length)
	const tokenConsumerSlots = new Map<Token, Slot[]>()

	for (let slot = 0; slot < normalizedBySlot.length; slot++) {
		const decl = normalizedBySlot[slot]
		if (!decl) continue
		const resolvedDeps: Slot[] = []
		for (const depToken of decl.deps) {
			const consumers = tokenConsumerSlots.get(depToken)
			if (consumers) {
				if (!consumers.includes(slot)) consumers.push(slot)
			} else tokenConsumerSlots.set(depToken, [slot])
			const depSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotByKey, depToken)
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
	}

	if (issues.length === 0) {
		const color = new Uint8Array(keyBySlot.length)
		const stack: Slot[] = []
		const stackIndex = new Map<Slot, number>()
		for (let slot = 0; slot < keyBySlot.length; slot++) {
			if (!declarationsBySlot[slot] || color[slot] !== 0) continue
			visitCycleSlots(
				slot,
				(current) => depsBySlot[current] ?? emptySlotArray,
				(current) => declarationsBySlot[current] !== undefined,
				(current) => keyBySlot[current],
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

	return ok(
		new GraphSnapshot<M>({
			revision,
			slotByKey,
			keyBySlot,
			declarationsBySlot,
			createsBySlot,
			depsBySlot,
			dependentsBySlot,
			tokenOwnerSlots,
			tokenConsumerSlots: new Map(
				[...tokenConsumerSlots.entries()].map(([token, slots]) => [token, finishArray(slots)]),
			),
		}),
	)
}

const finalizeChangedTokenConsumerSlots = (
	map: Map<Token, readonly Slot[] | Slot[]>,
	changed: ReadonlySet<Token>,
): ReadonlyMap<Token, readonly Slot[]> => {
	for (const token of changed) {
		const slots = map.get(token)
		if (!slots) continue
		map.set(token, finishArray(slots as Slot[]))
	}
	return map as ReadonlyMap<Token, readonly Slot[]>
}

const updateTokenOwnersForDirtySlots = <M>(args: {
	prevDecls: Array<NormalizedProviderDecl<unknown, M> | undefined>
	nextDecls: Array<NormalizedProviderDecl<unknown, M> | undefined>
	dirty: ReadonlySet<Slot>
	tokenOwnerSlots: Map<Token, Slot>
	touchedTokens: Set<Token>
	slotByKey: ReadonlyMap<NodeKey, Slot>
	keyBySlot: readonly (NodeKey | undefined)[]
	issues: GraphBuildIssue[]
}): void => {
	const {
		prevDecls,
		nextDecls,
		dirty,
		tokenOwnerSlots,
		touchedTokens,
		slotByKey,
		keyBySlot,
		issues,
	} = args

	for (const slot of dirty) {
		const before = prevDecls[slot]
		if (!before) continue
		for (const token of before.explicitTokens) {
			touchedTokens.add(token)
			const ownerSlot = tokenOwnerSlots.get(token)
			if (ownerSlot !== undefined && ownerSlot === slot) tokenOwnerSlots.delete(token)
		}
	}

	for (const slot of dirty) {
		const after = nextDecls[slot]
		if (!after) continue
		if (after.create.kind === 'value' && after.deps.length > 0) {
			issues.push({
				kind: 'InvalidDeclaration',
				nodeKey: after.key,
				message: 'value providers can not declare dependencies',
			})
		}
		for (const token of after.explicitTokens) {
			touchedTokens.add(token)
			const ownerSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotByKey, token)
			if (ownerSlot === undefined || ownerSlot === slot) tokenOwnerSlots.set(token, slot)
			else {
				const ownerKey = keyBySlot[ownerSlot]
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

	for (const slot of dirty) markSlot(dirtyMarks, dirtySlots, slot)

	for (let i = 0; i < dirtySlots.length; i++) {
		const slot = dirtySlots[i]!
		if (markSlot(affectedMarks, affectedStack, slot)) affectedSlots.push(slot)
	}
	for (let i = 0; i < retargetedTokens.length; i++) {
		const { token } = retargetedTokens[i]!
		for (const consumerSlot of prev.tokenConsumerSlotsOf(token)) {
			if (markSlot(affectedMarks, affectedStack, consumerSlot)) affectedSlots.push(consumerSlot)
		}
	}
	while (affectedStack.length > 0) {
		const current = affectedStack.pop()!
		const dependents = prev.dependentSlotsOf(current)
		for (let i = 0; i < dependents.length; i++) {
			const dependentSlot = dependents[i]!
			if (markSlot(affectedMarks, affectedStack, dependentSlot)) affectedSlots.push(dependentSlot)
		}
	}

	return affectedSlots
}

const collectGraphDelta = <M>(args: {
	prevDecls: Array<NormalizedProviderDecl<unknown, M> | undefined>
	nextDecls: Array<NormalizedProviderDecl<unknown, M> | undefined>
	dirtySlots: readonly Slot[]
	affectedSlots: readonly Slot[]
	retargetedTokens: readonly {
		token: Token
		from?: NodeKey
		to?: NodeKey
	}[]
}): GraphDelta => {
	const { prevDecls, nextDecls, dirtySlots, affectedSlots, retargetedTokens } = args
	const removed: NodeKey[] = []
	const added: NodeKey[] = []
	const replaced = new Map<NodeKey, NodeKey>()

	for (let i = 0; i < dirtySlots.length; i++) {
		const slot = dirtySlots[i]!
		const before = prevDecls[slot]
		const after = nextDecls[slot]
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
		const beforeKey = prevDecls[slot]?.key
		const afterKey = nextDecls[slot]?.key
		if (beforeKey !== undefined) affected.add(beforeKey)
		if (afterKey !== undefined) affected.add(afterKey)
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
	dirty: ReadonlySet<Slot>,
	revision: number,
	scratch: BuildScratch,
): Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError> => {
	const issues: GraphBuildIssue[] = []
	const slotByKey = nextState.slotByKey
	const keyBySlot = nextState.keyBySlot
	const prevDecls = prevState.declsBySlot
	const nextDecls = nextState.declsBySlot
	const dirtyMarks = scratch.dirtyMarks
	const dirtySlots = scratch.dirtySlots
	const affectedSlots = scratch.affectedSlots
	const affectedStack = scratch.affectedStack
	const changedDependentMarks = scratch.changedDependentMarks
	const changedDependentSlots = scratch.changedDependentSlots
	dirtySlots.length = 0
	affectedSlots.length = 0
	affectedStack.length = 0
	changedDependentSlots.length = 0

	const tokenOwnerSlots = new Map(prev.tokenOwnerSlots())
	const touchedTokens = new Set<Token>()
	updateTokenOwnersForDirtySlots({
		prevDecls,
		nextDecls,
		dirty,
		tokenOwnerSlots,
		touchedTokens,
		slotByKey,
		keyBySlot,
		issues,
	})

	const retargetedTokens = computeRetargetedTokens(
		touchedTokens,
		(token) => prev.resolve(token),
		(token) => {
			const slot = resolveTokenSlotFromTable(tokenOwnerSlots, slotByKey, token)
			return slot === undefined ? undefined : keyBySlot[slot]
		},
	)
	collectAffectedSlots(prev, dirty, retargetedTokens, scratch)

	const declarationsBySlot = prev.declarationsBySlot().slice()
	const createsBySlot = prev.createsBySlot().slice()
	const depsBySlot = prev.depsBySlot().slice()
	const dependentsBySlot = prev.dependentsBySlot().slice()
	const tokenConsumerSlots = new Map<Token, readonly Slot[] | Slot[]>(prev.tokenConsumerSlots())
	const changedTokenConsumers = new Set<Token>()

	for (const slot of affectedSlots) {
		const beforeDecl = prevDecls[slot]
		const afterDecl = nextDecls[slot]
		const beforeKey = beforeDecl?.key
		const afterKey = afterDecl?.key
		const beforeDepSlots = prev.depSlotsOf(slot)
		const declarationChanged = beforeKey !== afterKey || dirtyMarks[slot] === 1
		const hadNodeBefore = beforeKey !== undefined && beforeDecl !== undefined

		if (hadNodeBefore) {
			for (let i = 0; i < beforeDepSlots.length; i++) {
				removeFromMutableSlotTable(
					dependentsBySlot as Array<readonly Slot[] | Slot[] | undefined>,
					beforeDepSlots[i]!,
					slot,
					changedDependentMarks,
					changedDependentSlots,
				)
			}
			if (declarationChanged) {
				for (const depToken of beforeDecl.deps) {
					removeFromMutableSlotListMap(tokenConsumerSlots, depToken, slot, changedTokenConsumers)
				}
			}
		}

		if (!afterDecl || afterKey === undefined) {
			declarationsBySlot[slot] = undefined
			createsBySlot[slot] = undefined
			depsBySlot[slot] = emptySlotArray
			dependentsBySlot[slot] = emptySlotArray
			continue
		}

		const resolvedDeps: Slot[] = []
		for (const depToken of afterDecl.deps) {
			if (declarationChanged) {
				addToMutableSlotListMap(tokenConsumerSlots, depToken, slot, changedTokenConsumers)
			}
			const depSlot = resolveTokenSlotFromTable(tokenOwnerSlots, slotByKey, depToken)
			if (depSlot === undefined) {
				issues.push({ kind: 'MissingDependency', nodeKey: afterKey, token: depToken })
				continue
			}
			resolvedDeps.push(depSlot)
			addToMutableSlotTable(
				dependentsBySlot as Array<readonly Slot[] | Slot[] | undefined>,
				depSlot,
				slot,
				changedDependentMarks,
				changedDependentSlots,
			)
		}

		const currentDeclaration = declarationsBySlot[slot]
		declarationsBySlot[slot] =
			declarationChanged || !currentDeclaration
				? createGraphDeclaration(afterDecl)
				: currentDeclaration
		createsBySlot[slot] =
			declarationChanged || !createsBySlot[slot] ? afterDecl.create : createsBySlot[slot]
		depsBySlot[slot] = finishArray(resolvedDeps)
		if (!dependentsBySlot[slot]) dependentsBySlot[slot] = emptySlotArray
	}

	if (issues.length === 0) {
		const color = new Uint8Array(keyBySlot.length)
		const stack: Slot[] = []
		const stackIndex = new Map<Slot, number>()
		for (const slot of affectedSlots) {
			if (declarationsBySlot[slot] === undefined || color[slot] !== 0) continue
			visitCycleSlots(
				slot,
				(current) => depsBySlot[current] ?? emptySlotArray,
				(current) => declarationsBySlot[current] !== undefined,
				(current) => keyBySlot[current],
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
		const dependents = dependentsBySlot[slot]
		if (!dependents) {
			dependentsBySlot[slot] = emptySlotArray
			continue
		}
		dependentsBySlot[slot] = finishArray(dependents as Slot[])
	}

	return ok({
		graph: new GraphSnapshot<M>({
			revision,
			slotByKey,
			keyBySlot,
			declarationsBySlot,
			createsBySlot,
			depsBySlot,
			dependentsBySlot,
			tokenOwnerSlots,
			tokenConsumerSlots: finalizeChangedTokenConsumerSlots(
				tokenConsumerSlots,
				changedTokenConsumers,
			),
		}),
		delta: collectGraphDelta({
			prevDecls,
			nextDecls,
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
	cache: input.cache,
	meta: input.meta,
	create: { kind: 'value', value: input.use },
})

export class DraftGraph<M = unknown> {
	private committedState = createDraftState<M>()
	private draftState = createDraftState<M>()
	private readonly sealedDraftStates = new WeakSet<DraftState<M>>()
	private dirty = new Set<Slot>()
	private buildScratch = createBuildScratch(0)
	private mutationVersion = 0
	private previewCache?: PreviewCache<M>
	private planningCache?: PlanningCache<M>
	private committedGraph = GraphSnapshot.empty<M>()
	public readonly instances = new InstanceStore<NodeKey, unknown>()

	public get graph(): GraphSnapshot<M> {
		return this.committedGraph
	}

	public has(nodeKey: NodeKey): boolean {
		return this.draftState.slotByKey.has(nodeKey)
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

		const explicitTokenOwnerSlots = new Map<Token, Slot | null>()
		const providerSlotsByToken = new Map<Token, Slot[]>()
		const consumerSlotsByToken = new Map<Token, Slot[]>()

		for (let slot = 0; slot < builtState.declsBySlot.length; slot++) {
			const decl = builtState.declsBySlot[slot]
			if (!decl) continue
			for (const token of decl.tokens) {
				addToSlotListMap(providerSlotsByToken, token, slot)
			}
			for (const token of decl.explicitTokens) {
				const current = explicitTokenOwnerSlots.get(token)
				if (current === undefined) {
					explicitTokenOwnerSlots.set(token, slot)
					continue
				}
				if (current !== slot) explicitTokenOwnerSlots.set(token, null)
			}
			for (const depToken of decl.deps) {
				addToSlotListMap(consumerSlotsByToken, depToken, slot)
			}
		}

		const planning: PlanningCache<M> = {
			builtAtVersion,
			builtState,
			explicitTokenOwnerSlots,
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
		const explicitOwnerSlot = planning.explicitTokenOwnerSlots.get(token)
		if (explicitOwnerSlot === null) return undefined
		if (explicitOwnerSlot !== undefined) return explicitOwnerSlot
		if (!isDefaultTokenCandidate(token)) return undefined
		return planning.builtState.slotByKey.get(token as NodeKey)
	}

	public resolvePlanningToken(token: Token): NodeKey | undefined {
		const planning = this.planningState()
		const slot = this.resolvePlanningTokenSlot(token, planning)
		return slot === undefined ? undefined : planning.builtState.keyBySlot[slot]
	}

	public collectCascadeTargets(handle: NodeKey | Token): Set<NodeKey> {
		const planning = this.planningState()
		const slotMarks = new Uint8Array(planning.builtState.keyBySlot.length)
		const tokenMarks = new Set<Token>()
		const pendingSlots: Slot[] = []
		const pendingTokens: Token[] = []
		const affected = new Set<NodeKey>()

		const queueSlot = (slot: Slot | undefined) => {
			if (slot === undefined || slot < 0 || slot >= slotMarks.length) return
			if (slotMarks[slot] === 1) return
			slotMarks[slot] = 1
			pendingSlots.push(slot)
		}
		const queueToken = (token: Token) => {
			if (tokenMarks.has(token)) return
			tokenMarks.add(token)
			pendingTokens.push(token)
		}

		queueSlot(planning.builtState.slotByKey.get(handle as NodeKey))
		if (isDefaultTokenCandidate(handle as NodeKey)) {
			const token = handle as Token
			queueSlot(this.resolvePlanningTokenSlot(token, planning))
			queueToken(token)
		}

		while (pendingSlots.length > 0 || pendingTokens.length > 0) {
			while (pendingSlots.length > 0) {
				const slot = pendingSlots.pop()!
				const decl = planning.builtState.declsBySlot[slot]
				if (!decl) continue
				affected.add(decl.key)
				for (let i = 0; i < decl.tokens.length; i++) queueToken(decl.tokens[i]!)
			}

			while (pendingTokens.length > 0) {
				const token = pendingTokens.pop()!
				const providers = planning.providerSlotsByToken.get(token)
				if (providers) {
					for (let i = 0; i < providers.length; i++) queueSlot(providers[i]!)
				}
				const consumers = planning.consumerSlotsByToken.get(token)
				if (consumers) {
					for (let i = 0; i < consumers.length; i++) queueSlot(consumers[i]!)
				}
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
		preferredSlot?: Slot,
	): Slot | undefined {
		let slot = preferredSlot ?? state.slotByKey.get(normalized.key)
		if (slot === undefined) {
			slot = state.freeSlots.pop() ?? state.keyBySlot.length
		}
		const current = state.declsBySlot[slot]
		if (current && state.keyBySlot[slot] === normalized.key && declEqual(current, normalized)) {
			return undefined
		}
		state.slotByKey.set(normalized.key, slot)
		state.keyBySlot[slot] = normalized.key
		state.declsBySlot[slot] = normalized
		return slot
	}

	private releaseSlot(state: DraftState<M>, slot: Slot, key: NodeKey): void {
		state.slotByKey.delete(key)
		state.keyBySlot[slot] = undefined
		state.declsBySlot[slot] = undefined
		state.freeSlots.push(slot)
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

		const fromSlot = state.slotByKey.get(fromKey)
		if (fromSlot === undefined) {
			const slot = this.writeNormalized(state, normalized)
			if (slot === undefined) return
			this.dirty.add(slot)
			this.mutationVersion += 1
			return
		}

		const existingTargetSlot = state.slotByKey.get(normalized.key)
		if (existingTargetSlot !== undefined && existingTargetSlot !== fromSlot) {
			this.releaseSlot(state, existingTargetSlot, normalized.key)
			this.dirty.add(existingTargetSlot)
		}

		state.slotByKey.delete(fromKey)
		this.writeNormalized(state, normalized, fromSlot)
		this.dirty.add(fromSlot)
		this.mutationVersion += 1
	}

	public remove(nodeKey: NodeKey): boolean {
		this.ensureMutableDraftState()
		this.invalidatePreviewCache()
		const state = this.draftState
		const slot = state.slotByKey.get(nodeKey)
		if (slot === undefined) return false
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
		return builtState === this.committedState
			? computeDirtySlots(this.committedState, builtState)
			: new Set(this.dirty)
	}

	private buildSnapshotFromState(
		builtState: DraftState<M>,
		dirty: ReadonlySet<Slot>,
	): Result<{ graph: GraphSnapshot<M>; delta: GraphDelta }, GraphBuildError> {
		if (this.committedGraph.revision === 0) {
			const nextGraphResult = buildFullSnapshot(builtState, this.committedGraph.revision + 1)
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

		this.buildScratch = ensureBuildScratch(
			this.buildScratch,
			Math.max(this.committedGraph.slotCount(), builtState.keyBySlot.length),
		)
		const nextGraphResult = (() => {
			try {
				return buildIncrementalSnapshot(
					this.committedGraph,
					this.committedState,
					builtState,
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
		this.committedState = builtState
		if (builtAtVersion === this.mutationVersion) {
			this.draftState = builtState
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
