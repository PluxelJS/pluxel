import {
	compileLogFilter,
	matchesLogFilterCompiled,
	type CompiledLogFilter,
	type LogFilter,
	type LogRangeResult,
	type LogStreamMeta,
	type RuntimeLogLine,
} from './protocol'

const LOG_EVENT = 'runtime_log_append'
const RESET_EVENT = 'runtime_log_reset'

type StoreEventName = typeof LOG_EVENT | typeof RESET_EVENT
type StoreEventPayload = {
	[LOG_EVENT]: RuntimeLogStoreAppend
	[RESET_EVENT]: RuntimeLogStoreReset
}
type StoreEventHandler = (ev: RuntimeLogStoreAppend | RuntimeLogStoreReset) => void

class StoreEmitter {
	private handlers = new Map<StoreEventName, Set<StoreEventHandler>>()

	on<E extends StoreEventName>(name: E, fn: (ev: StoreEventPayload[E]) => void): void {
		let set = this.handlers.get(name)
		if (!set) {
			set = new Set()
			this.handlers.set(name, set)
		}
		set.add(fn as unknown as StoreEventHandler)
	}

	off<E extends StoreEventName>(name: E, fn: (ev: StoreEventPayload[E]) => void): void {
		const set = this.handlers.get(name)
		if (!set) return
		set.delete(fn as unknown as StoreEventHandler)
		if (set.size === 0) this.handlers.delete(name)
	}

	emit<E extends StoreEventName>(name: E, ev: StoreEventPayload[E]): void {
		const set = this.handlers.get(name)
		if (!set || set.size === 0) return
		for (const fn of set) {
			try {
				;(fn as (ev: StoreEventPayload[E]) => void)(ev)
			} catch {
				// ignore listener errors
			}
		}
	}
}

const randomBootId = (): string => {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	if (c?.randomUUID) return c.randomUUID()
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export type RuntimeLogStoreAppend = {
	type: 'append'
	streamId: string
	epoch: number
	fromSeq: string
	nextSeq: string
	lines: RuntimeLogLine[]
}

export type RuntimeLogStoreReset = {
	type: 'reset'
	streamId: string
	bootId: string
	epoch: number
	headSeq: string
	tailSeq: string
	nextSeq: string
	count: number
	retention: { windowLines: number }
}

export type RuntimeLogStoreListener = (ev: RuntimeLogStoreAppend | RuntimeLogStoreReset) => void

export type RuntimeLogStoreOptions = {
	streamId: string
	windowLines?: number
	epoch?: number
}

const CHUNK_SIZE = 1024

function parseSeq(raw: string): bigint | null {
	try {
		if (!raw) return null
		// Only allow unsigned decimal (SSE id, query params).
		if (!/^\d+$/.test(raw)) return null
		return BigInt(raw)
	} catch {
		return null
	}
}

function seqToString(n: bigint): string {
	return n.toString(10)
}

type CounterMap = Map<string, number>

type ChunkMeta = {
	pluginId: CounterMap
	context: CounterMap
	name: CounterMap
	categoryFull: CounterMap
	categoryPrefix: CounterMap
}

type Chunk = {
	lines: Array<RuntimeLogLine | undefined>
	start: number
	len: number
	meta: ChunkMeta
}

function createCounterMap(): CounterMap {
	return new Map()
}

function createChunk(): Chunk {
	return {
		lines: Array(CHUNK_SIZE),
		start: 0,
		len: 0,
		meta: {
			pluginId: createCounterMap(),
			context: createCounterMap(),
			name: createCounterMap(),
			categoryFull: createCounterMap(),
			categoryPrefix: createCounterMap(),
		},
	}
}

function inc(map: CounterMap, key: string, delta: 1 | -1): void {
	const prev = map.get(key) ?? 0
	const next = prev + delta
	if (next <= 0) map.delete(key)
	else map.set(key, next)
}

function addCategoryMeta(meta: ChunkMeta, category: string[], delta: 1 | -1): void {
	if (!Array.isArray(category) || category.length === 0) return
	const joined = category.join('.')
	if (!joined) return
	inc(meta.categoryFull, joined, delta)

	// Prefix keys for fast "prefix.*" checks (and exact still uses categoryFull).
	let prefix = ''
	for (let i = 0; i < category.length; i++) {
		const part = category[i]
		if (!part) break
		prefix = prefix ? `${prefix}.${part}` : part
		inc(meta.categoryPrefix, prefix, delta)
	}
}

function addLineMeta(meta: ChunkMeta, line: RuntimeLogLine, delta: 1 | -1): void {
	if (line.pluginId) inc(meta.pluginId, line.pluginId, delta)
	if (line.context) inc(meta.context, line.context, delta)
	if (line.name) inc(meta.name, line.name, delta)
	addCategoryMeta(meta, line.category, delta)
}

function chunkGet(chunk: Chunk, index: number): RuntimeLogLine | undefined {
	if (index < 0 || index >= chunk.len) return undefined
	const idx = (chunk.start + index) % CHUNK_SIZE
	return chunk.lines[idx]
}

function chunkPush(chunk: Chunk, line: RuntimeLogLine): void {
	const idx = (chunk.start + chunk.len) % CHUNK_SIZE
	chunk.lines[idx] = line
	chunk.len++
	addLineMeta(chunk.meta, line, 1)
}

function chunkShift(chunk: Chunk): RuntimeLogLine | undefined {
	if (chunk.len === 0) return undefined
	const idx = chunk.start
	const line = chunk.lines[idx]
	if (line) addLineMeta(chunk.meta, line, -1)
	chunk.lines[idx] = undefined
	chunk.start = (chunk.start + 1) % CHUNK_SIZE
	chunk.len--
	return line
}

function chunkMayMatch(meta: ChunkMeta, f: CompiledLogFilter): boolean {
	if (!f.hasFilter) return true
	if (f.pluginId && !meta.pluginId.has(f.pluginId)) return false
	if (f.context && !meta.context.has(f.context)) return false
	if (f.displayName && !meta.name.has(f.displayName)) return false
	if (f.nameAny) {
		const v = f.nameAny
		if (!meta.pluginId.has(v) && !meta.context.has(v) && !meta.name.has(v)) return false
	}
	if (f.categoryKey) {
		if (f.categoryPrefix) {
			if (!meta.categoryPrefix.has(f.categoryKey)) return false
		} else {
			if (!meta.categoryFull.has(f.categoryKey)) return false
		}
	}
	return true
}

export class RuntimeLogStore {
	public readonly streamId: string
	public readonly bootId: string = randomBootId()
	private readonly cap: number
	private readonly chunks: Array<Chunk | undefined>
	private readonly maxChunks: number
	private headChunk = 0
	private tailChunk = 0
	private chunkCount = 0
	private count = 0
	private epoch: number

	// Head/tail are global cursors across the entire stream (unfiltered).
	private headSeq: bigint
	private tailSeq: bigint
	private nextSeq: bigint

	private readonly events = new StoreEmitter()
	private subscribers = 0

	constructor(opts: RuntimeLogStoreOptions) {
		this.streamId = opts.streamId
		this.cap = Math.min(Math.max(1, Math.floor(opts.windowLines ?? 200_000)), 2_000_000)
		this.maxChunks = Math.min(Math.ceil(this.cap / CHUNK_SIZE) + 4, 10_000)
		this.chunks = Array(this.maxChunks)
		this.epoch = Math.max(1, Math.floor(opts.epoch ?? 1))
		this.headSeq = 1n
		this.tailSeq = 0n
		this.nextSeq = 1n
	}

	get subscriberCount() {
		return this.subscribers
	}

	meta(): LogStreamMeta {
		return {
			streamId: this.streamId,
			bootId: this.bootId,
			epoch: this.epoch,
			headSeq: seqToString(this.headSeq),
			tailSeq: seqToString(this.tailSeq),
			nextSeq: seqToString(this.nextSeq),
			count: this.count,
			retention: { windowLines: this.cap },
		}
	}

	reset(nextEpoch?: number): void {
		this.epoch = Math.max(1, Math.floor(nextEpoch ?? this.epoch + 1))
		this.headChunk = 0
		this.tailChunk = 0
		this.chunkCount = 0
		this.count = 0
		this.headSeq = 1n
		this.tailSeq = 0n
		this.nextSeq = 1n
		this.chunks.fill()
		const meta = this.meta()
		this.events.emit(RESET_EVENT, {
			type: 'reset',
			streamId: meta.streamId,
			bootId: meta.bootId,
			epoch: meta.epoch,
			headSeq: meta.headSeq,
			tailSeq: meta.tailSeq,
			nextSeq: meta.nextSeq,
			count: meta.count,
			retention: meta.retention,
		} satisfies RuntimeLogStoreReset)
	}

	append(inputs: Array<Omit<RuntimeLogLine, 'epoch' | 'seq' | 'streamId'>>): RuntimeLogStoreAppend {
		if (inputs.length === 0) {
			return {
				type: 'append',
				streamId: this.streamId,
				epoch: this.epoch,
				fromSeq: seqToString(this.nextSeq),
				nextSeq: seqToString(this.nextSeq),
				lines: [],
			}
		}

		const epoch = this.epoch
		const from = this.nextSeq
		const out = Array<RuntimeLogLine>(inputs.length)

		for (let i = 0; i < inputs.length; i++) {
			const seq = this.nextSeq++
			const line: RuntimeLogLine = {
				...inputs[i]!,
				streamId: this.streamId,
				epoch,
				seq: seqToString(seq),
			}
			out[i] = line

			this.appendOne(line)
			this.tailSeq = seq
		}

		const ev: RuntimeLogStoreAppend = {
			type: 'append',
			streamId: this.streamId,
			epoch,
			fromSeq: seqToString(from),
			nextSeq: seqToString(this.nextSeq),
			lines: out,
		}
		this.events.emit(LOG_EVENT, ev)
		return ev
	}

	private appendOne(line: RuntimeLogLine): void {
		// Ensure tail chunk exists and has capacity.
		if (this.chunkCount === 0) {
			const c = createChunk()
			this.chunks[0] = c
			this.headChunk = 0
			this.tailChunk = 0
			this.chunkCount = 1
		}

		let tail = this.chunks[this.tailChunk]!
		if (tail.len >= CHUNK_SIZE) {
			const nextTail = (this.tailChunk + 1) % this.maxChunks
			// Safety: we should never fully wrap because maxChunks includes slack.
			if (this.chunkCount >= this.maxChunks && nextTail === this.headChunk) {
				// Best-effort: drop everything and restart (prevents a hard crash in extreme configs).
				this.reset(this.epoch + 1)
				const fresh = createChunk()
				this.chunks[0] = fresh
				this.headChunk = 0
				this.tailChunk = 0
				this.chunkCount = 1
				tail = fresh
			} else {
				const c = createChunk()
				this.chunks[nextTail] = c
				this.tailChunk = nextTail
				this.chunkCount++
				tail = c
			}
		}

		chunkPush(tail, line)
		this.count++

		// Enforce retention (line-based).
		while (this.count > this.cap) this.evictOne()
	}

	private evictOne(): void {
		if (this.count === 0 || this.chunkCount === 0) return
		const head = this.chunks[this.headChunk]
		if (!head) {
			// Repair corruption defensively.
			this.reset(this.epoch + 1)
			return
		}

		const removed = chunkShift(head)
		if (removed) {
			this.count--
			this.headSeq++
		}

		if (head.len === 0) {
			this.chunks[this.headChunk] = undefined
			this.headChunk = (this.headChunk + 1) % this.maxChunks
			this.chunkCount--
			if (this.chunkCount === 0) {
				// Reset chunk pointers to a stable state.
				this.headChunk = 0
				this.tailChunk = 0
			}
		}
	}

	range(input: {
		epoch: number
		fromSeq: string
		limit: number
		filter?: LogFilter
	}): LogRangeResult {
		const epoch = Math.floor(input.epoch)
		if (!Number.isFinite(epoch) || epoch <= 0)
			return { ok: false, code: 'invalid', message: 'Invalid epoch' }
		if (epoch !== this.epoch) {
			const meta = this.meta()
			return {
				ok: false,
				code: 'epoch_mismatch',
				streamId: meta.streamId,
				epoch: meta.epoch,
				headSeq: meta.headSeq,
				tailSeq: meta.tailSeq,
			}
		}

		const limit = Math.min(Math.max(1, Math.floor(input.limit)), this.cap)
		const from = parseSeq(input.fromSeq)
		if (from === null) return { ok: false, code: 'invalid', message: 'Invalid fromSeq' }

		if (this.count === 0) {
			const meta = this.meta()
			return {
				ok: true,
				streamId: meta.streamId,
				epoch: meta.epoch,
				fromSeq: input.fromSeq,
				nextSeq: meta.nextSeq,
				lines: [],
			}
		}

		if (from < this.headSeq) {
			const meta = this.meta()
			return {
				ok: false,
				code: 'from_too_old',
				streamId: meta.streamId,
				epoch: meta.epoch,
				headSeq: meta.headSeq,
				tailSeq: meta.tailSeq,
			}
		}

		// Clamp to the newest+1: allow "tail+1" as a valid "already caught up" cursor.
		if (from > this.tailSeq + 1n) {
			return { ok: false, code: 'invalid', message: 'fromSeq is ahead of tail' }
		}
		if (from === this.tailSeq + 1n) {
			const meta = this.meta()
			return {
				ok: true,
				streamId: meta.streamId,
				epoch: meta.epoch,
				fromSeq: input.fromSeq,
				nextSeq: meta.nextSeq,
				lines: [],
			}
		}

		const filter = input.filter
		const compiled = compileLogFilter(filter)

		const startOffset = Number(from - this.headSeq) // safe: window <= cap
		const lines: RuntimeLogLine[] = []

		const remainingTotal = this.count - startOffset
		let scannedTotal = 0

		// Locate the starting chunk/offset.
		let idx = this.headChunk
		let chunk = this.chunks[idx]
		if (!chunk) {
			const meta = this.meta()
			return {
				ok: true,
				streamId: meta.streamId,
				epoch: meta.epoch,
				fromSeq: input.fromSeq,
				nextSeq: meta.nextSeq,
				lines: [],
			}
		}

		let offset = startOffset
		while (chunk && offset >= chunk.len) {
			offset -= chunk.len
			idx = (idx + 1) % this.maxChunks
			chunk = this.chunks[idx]
		}

		while (chunk && scannedTotal < remainingTotal) {
			let pos = scannedTotal === 0 ? offset : 0
			const chunkRemaining = chunk.len - pos

			// Fast skip: if we are aligned to the beginning of this chunk and we know it can't match,
			// skip it as a whole while still advancing the cursor correctly.
			if (pos === 0 && compiled.hasFilter && !chunkMayMatch(chunk.meta, compiled)) {
				scannedTotal += chunkRemaining
				idx = (idx + 1) % this.maxChunks
				chunk = this.chunks[idx]
				continue
			}

			for (; pos < chunk.len && scannedTotal < remainingTotal; pos++) {
				const line = chunkGet(chunk, pos)
				if (!line) {
					scannedTotal++
					continue
				}
				if (!compiled.hasFilter || matchesLogFilterCompiled(line, compiled)) lines.push(line)
				scannedTotal++
				if (lines.length >= limit) break
			}
			if (lines.length >= limit) break

			idx = (idx + 1) % this.maxChunks
			chunk = this.chunks[idx]
		}

		const next = from + BigInt(scannedTotal)
		return {
			ok: true,
			streamId: this.streamId,
			epoch: this.epoch,
			fromSeq: input.fromSeq,
			nextSeq: seqToString(next),
			lines,
		}
	}

	subscribe(listener: RuntimeLogStoreListener): () => void {
		const onAppend = (ev: RuntimeLogStoreAppend) => listener(ev)
		const onReset = (ev: RuntimeLogStoreReset) => listener(ev)
		this.events.on(LOG_EVENT, onAppend)
		this.events.on(RESET_EVENT, onReset)
		this.subscribers++
		return () => {
			this.events.off(LOG_EVENT, onAppend)
			this.events.off(RESET_EVENT, onReset)
			this.subscribers = Math.max(0, this.subscribers - 1)
		}
	}

	/**
	 * Fast path for "tail N" queries (used by the UI initial snapshot).
	 * Returns a contiguous, unfiltered window (caller can filter client-side).
	 */
	tailWindow(limit: number): RuntimeLogLine[] {
		const n = Math.min(Math.max(0, Math.floor(limit)), this.count)
		if (n === 0) return []
		if (this.chunkCount === 0) return []

		const out = Array<RuntimeLogLine>(n)
		let need = n

		let idx = this.tailChunk
		let chunk = this.chunks[idx]
		if (!chunk) return []
		let pos = chunk.len - 1

		while (need > 0 && chunk) {
			const line = chunkGet(chunk, pos)
			if (line) {
				out[need - 1] = line
				need--
			}
			pos--
			if (need === 0) break
			if (pos < 0) {
				// Move to the previous chunk in ring order.
				idx = (idx - 1 + this.maxChunks) % this.maxChunks
				chunk = this.chunks[idx]
				// Skip empty slots (should be rare).
				let guard = 0
				while (!chunk && guard++ < this.maxChunks) {
					idx = (idx - 1 + this.maxChunks) % this.maxChunks
					chunk = this.chunks[idx]
				}
				if (!chunk) break
				pos = chunk.len - 1
			}
		}

		// If we couldn't fill (shouldn't happen unless corruption), trim.
		return need === 0 ? out : out.slice(need)
	}
}

type RegistryDefaults = {
	windowLines: number
}

const DEFAULTS: RegistryDefaults = {
	windowLines: 200_000,
}

class RuntimeLogStoreRegistry {
	private readonly stores = new Map<string, RuntimeLogStore>()
	private readonly maxStores: number

	constructor(opts: { maxStores?: number } = {}) {
		this.maxStores = Math.min(Math.max(2, Math.floor(opts.maxStores ?? 64)), 10_000)
	}

	get(streamId: string): RuntimeLogStore | undefined {
		const existing = this.stores.get(streamId)
		if (!existing) return undefined
		// Bump LRU.
		this.stores.delete(streamId)
		this.stores.set(streamId, existing)
		return existing
	}

	list(): RuntimeLogStore[] {
		return [...this.stores.values()]
	}

	getOrCreate(streamId: string, opts: Partial<RuntimeLogStoreOptions> = {}): RuntimeLogStore {
		const existing = this.get(streamId)
		if (existing) return existing
		const next = new RuntimeLogStore({
			streamId,
			windowLines: opts.windowLines ?? DEFAULTS.windowLines,
			epoch: opts.epoch ?? 1,
		})
		this.stores.set(streamId, next)
		this.prune()
		return next
	}

	private prune(): void {
		if (this.stores.size <= this.maxStores) return
		// Evict least-recently-used stores with no active subscribers (never evict "default").
		for (const [k, store] of this.stores) {
			if (this.stores.size <= this.maxStores) break
			if (k === 'default') continue
			if (store.subscriberCount > 0) continue
			this.stores.delete(k)
		}
	}
}

export const runtimeLogStores = new RuntimeLogStoreRegistry()
export const runtimeLogs = runtimeLogStores.getOrCreate('default')
