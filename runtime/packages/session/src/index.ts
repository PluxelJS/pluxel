// session.plugin.ts
import { BasePlugin, Config, Plugin, v } from '@pluxel/hmr'
import {
  signal, computed, effect, effectScope, type EffectScope,
} from 'alien-signals'

/* ───────────────────────────── Config & Types ───────────────────────────── */

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_IDLE_MS = 30_000
const DEFAULT_MAX = 50_000
const DEFAULT_PING_THROTTLE_MS = 500

export const SessionCfgSchema = v.object({
  ttlMs: v.optional(v.number(), DEFAULT_TTL_MS),
  idleMs: v.optional(v.number(), DEFAULT_IDLE_MS),
  maxSessions: v.optional(v.number(), DEFAULT_MAX),
  pingThrottleMs: v.optional(v.number(), DEFAULT_PING_THROTTLE_MS),
})
export type SessionConfig = v.InferOutput<typeof SessionCfgSchema>

export interface SessionState<T extends object = Record<string, unknown>> {
  id: string
  rev: number               // 版本号：每次提交 +1（支持 CAS）
  online: boolean
  lastPing: number
  lastAccess: number
  data: T
}

export type ReadonlySignal<T> = (() => T) & { readonly set?: never }

export interface SessionHandle<T extends object = Record<string, unknown>> {
  readonly id: string
  readonly rev: number
  get(): SessionState<T>
  patch(patch: Partial<T>): void
  updateData(fn: (prev: T) => T): void
  setAt(path: (string | number)[], value: unknown): void
  ping(opts?: { force?: boolean }): void
  stop(): void
}

export type Stop = () => void

export type OverflowPolicy =
  | 'reject'
  | 'evict_idle'
  | 'evict_lru'
  | { pickVictim: (ctx: { now: number; nodes: Iterable<SessionState<any>> }) => string | undefined }

export interface SessionEvent {
  type: 'create' | 'remove' | 'expire' | 'online' | 'offline' | 'updateData'
  id: string
  now: number
  prev?: SessionState<any>
  next?: SessionState<any>
}

export interface SessionService {
  readonly maxSessions: number
  readonly metricsSignal: ReadonlySignal<{ total: number; online: number; idle: number }>

  open<T extends object = Record<string, unknown>>(
    id: string,
    opts?: {
      seed?: Partial<T>
      touch?: boolean           // 命中是否刷新 lastAccess（默认 true）
      ping?: boolean            // 命中是否立即 ping（默认 false）
      overrides?: Partial<Pick<SessionConfig, 'ttlMs' | 'idleMs' | 'pingThrottleMs'>>
      onFirstCreate?: (h: SessionHandle<T>) => void
    }
  ): SessionHandle<T>

  get<T extends object = Record<string, unknown>>(id: string): SessionHandle<T> | undefined
  has(id: string): boolean
  remove(id: string): boolean

  /** 原子事务：闭包内多次变更会被合并为一次提交（coalesce）。 */
  with<TData extends object, R>(
    id: string,
    fn: (h: SessionHandle<TData>) => R,
    opts?: { createIfMissing?: () => Partial<TData> } // 缺失时按需创建
  ): R

  /** 并发安全：预期版本一致才提交。返回是否成功。 */
  cas<T extends object>(
    id: string,
    expectedRev: number,
    next: (prev: Readonly<SessionState<T>>) => Partial<T> | T
  ): boolean

  /** 快照查询（一次性）：可选谓词/排序/上限。 */
  query(
    predicate?: (s: SessionState<any>) => boolean,
    limit?: number,
    sort?: (a: SessionState<any>, b: SessionState<any>) => number
  ): ReadonlyArray<SessionState<any>>

  /** 句柄查询：后续要写时更顺手。 */
  queryHandles<T extends object = Record<string, unknown>>(
    predicate?: (s: SessionState<T>) => boolean,
    limit?: number
  ): ReadonlyArray<SessionHandle<T>>

  /** 直接拿信号（UI 友好）：单会话派生切片。 */
  select<T>(id: string, selector: (s: SessionState<any>) => T): ReadonlySignal<T> | undefined

  /** 直接拿信号：查询结果集合。 */
  selectQuery(
    predicate?: (s: SessionState<any>) => boolean,
    limit?: number,
    sort?: (a: SessionState<any>, b: SessionState<any>) => number
  ): ReadonlySignal<ReadonlyArray<SessionState<any>>>

  /** 创建索引：keyFn 可返回单键或多键（数组）。 */
  createIndex<K extends string | number | symbol>(
    keyFn: (s: SessionState<any>) => K | K[]
  ): {
    get(key: K): ReadonlySet<string>
    size(key: K): number
    select(key: K): ReadonlySignal<ReadonlySet<string>>
    dispose(): void
  }

  /** 设置溢出策略（容量达上限时的行为）。 */
  setOverflowPolicy(policy: OverflowPolicy): void

  /** 事件总线（轻量）。 */
  on<E extends SessionEvent['type']>(type: E, cb: (e: Extract<SessionEvent, { type: E }>) => void): Stop
}

/* ───────────────────────────── Internal Node ────────────────────────────── */

class Node<T extends object> {
  public readonly state = signal<SessionState<T>>({} as any)
  private lastPingTs = 0
  private batchDepth = 0
  private staged: SessionState<T> | null = null

  constructor(
    public readonly id: string,
    private readonly cfg: Required<Pick<SessionConfig, 'ttlMs' | 'idleMs' | 'pingThrottleMs'>>,
    private readonly afterCommit: (prev: SessionState<T> | null, next: SessionState<T>) => void,
  ) {}

  init(seed: Partial<SessionState<T>> & { data?: Partial<T> }) {
    const now = Date.now()
    const initial: SessionState<T> = {
      id: this.id,
      rev: 0,
      online: true,
      lastPing: now,
      lastAccess: now,
      data: Object.assign({}, seed?.data) as T,
      ...seed,
    }
    this.commit(null, initial)
  }

  /** 开启/结束批量：期间的 commit 将合并为一次。 */
  beginBatch() { this.batchDepth++ }
  endBatch() {
    if (this.batchDepth === 0) return
    this.batchDepth--
    if (this.batchDepth === 0 && this.staged) {
      const prev = this.state()
      const next = this.staged
      this.staged = null
      this.state.set(next)
      this.afterCommit(prev, next)
    }
  }

  touch() {
    const s = this.state()
    this.commit(s, { ...s, lastAccess: Date.now() })
  }

  ping(force = false) {
    const now = Date.now()
    if (!force && now - this.lastPingTs < this.cfg.pingThrottleMs) return
    this.lastPingTs = now
    const s = this.state()
    this.commit(s, { ...s, lastPing: now, lastAccess: now, online: true })
  }

  patch(p: Partial<T>) {
    const s = this.state()
    this.commit(s, { ...s, data: Object.assign({}, s.data, p), lastAccess: Date.now() })
  }

  updateData(fn: (prev: T) => T) {
    const s = this.state()
    this.commit(s, { ...s, data: fn(s.data), lastAccess: Date.now() })
  }

  setAt(path: (string | number)[], value: unknown) {
    const s = this.state()
    this.commit(s, { ...s, data: setAtPath(s.data, path, value) as T, lastAccess: Date.now() })
  }

  markOfflineSoft(now: number) {
    const s = this.state()
    if (s.online) this.commit(s, { ...s, online: false, lastAccess: now })
  }

  /** CAS：rev 必须匹配。 */
  cas(expectedRev: number, mut: (prev: Readonly<SessionState<T>>) => Partial<T> | T): boolean {
    const s = this.state()
    if (s.rev !== expectedRev) return false
    const nextData = mut(s)
    const data = (isPlainObject(nextData) ? Object.assign({}, s.data, nextData) : nextData) as T
    this.commit(s, { ...s, data, lastAccess: Date.now() })
    return true
  }

  private commit(prev: SessionState<T> | null, next: SessionState<T>) {
    // 增版本，开发期冻结
    next = { ...next, rev: (prev?.rev ?? -1) + 1 }
    if (process.env.NODE_ENV !== 'production') {
      try {
        Object.freeze(next)
        if (next.data && typeof next.data === 'object') Object.freeze(next.data)
      } catch {}
    }
    if (this.batchDepth > 0) {
      this.staged = next
    } else {
      const old = prev ?? this.state()
      this.state.set(next)
      this.afterCommit(old, next)
    }
  }

  getCfg() { return this.cfg }
}

/* ───────────────────────────── Utilities ────────────────────────────────── */

function setAtPath(obj: any, path: (string | number)[], value: unknown): any {
  if (path.length === 0) return value
  const keys = path
  const stack: { parent: any; key: string | number }[] = []
  let cur = obj
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    stack.push({ parent: cur, key: k })
    cur = cur != null ? (cur as any)[k] : undefined
  }
  let acc = value
  for (let i = keys.length - 1; i >= 0; i--) {
    const { parent, key } = stack[i]
    const base =
      Array.isArray(parent)
        ? parent.slice()
        : parent && typeof parent === 'object'
          ? { ...parent }
          : typeof key === 'number'
            ? []
            : {}
    ;(base as any)[key] = acc
    acc = base
  }
  return acc
}

function isPlainObject(x: unknown): x is object {
  return !!x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype
}

const EMPTY_SET: ReadonlySet<any> = new Set()
const EMPTY_ARR: ReadonlyArray<any> = Object.freeze([])

/* ───────────────────────────── Session Plugin ───────────────────────────── */

@Plugin({ name: 'session' })
export class Session extends BasePlugin implements SessionService {
  @Config(SessionCfgSchema)
  private cfg!: SessionConfig

  private nodes = signal(new Map<string, Node<any>>())
  private overflowPolicy: OverflowPolicy = 'reject'
  private sweepTimer: any

  private listeners = new Map<SessionEvent['type'], Set<Function>>()

  private counts = computed(() => {
    const now = Date.now()
    let total = 0, online = 0, idle = 0
    for (const n of this.nodes().values()) {
      total++
      const s = n.state()
      if (s.online) online++
      if (!s.online && now - s.lastPing <= (n.getCfg().ttlMs)) idle++
    }
    return { total, online, idle }
  })
  public readonly metricsSignal = this.counts as ReadonlySignal<{ total: number; online: number; idle: number }>

  get maxSessions() { return this.cfg.maxSessions }

  /* ── lifecycle ── */

  async init(): Promise<void> {
    const tick = () => {
      const now = Date.now()
      const base = this.nodes()
      let changed = false
      const next = new Map(base)

      for (const [id, node] of base) {
        const s = node.state()
        const { idleMs, ttlMs } = node.getCfg()
        if (s.online && (now - s.lastPing > idleMs)) {
          node.markOfflineSoft(now)
          this.emit({ type: 'offline', id, now, prev: s, next: node.state() })
        }
        if (now - s.lastPing > ttlMs) {
          // 过期：统一 remove（会发 expire + remove）
          this.removeInternal(id, true /* expired */)
          changed = true
        }
      }

      if (changed) this.nodes.set(next)
    }

    this.sweepTimer = setInterval(
      tick,
      Math.min(Math.max(5_000, this.cfg.idleMs / 2), 60_000)
    )
    this.ctx.logger.info('[session] ready')
  }

  async stop(): Promise<void> {
    clearInterval(this.sweepTimer)
    const next = new Map(this.nodes())
    next.clear()
    this.nodes.set(next)
    this.listeners.clear()
    this.ctx.logger.info('[session] stopped')
  }

  /* ── core API ── */

  open<T extends object = Record<string, unknown>>(
    id: string,
    opts?: {
      seed?: Partial<T>
      touch?: boolean
      ping?: boolean
      overrides?: Partial<Pick<SessionConfig, 'ttlMs' | 'idleMs' | 'pingThrottleMs'>>
      onFirstCreate?: (h: SessionHandle<T>) => void
    }
  ): SessionHandle<T> {
    const touch = opts?.touch ?? true
    const ping = opts?.ping ?? false
    const base = this.nodes()
    let n = base.get(id) as Node<T> | undefined

    if (!n) {
      this.ensureCapacityOrEvict()
      // 会话的实际 cfg = 全局默认 + overrides
      const nodeCfg = {
        ttlMs: opts?.overrides?.ttlMs ?? this.cfg.ttlMs!,
        idleMs: opts?.overrides?.idleMs ?? this.cfg.idleMs!,
        pingThrottleMs: opts?.overrides?.pingThrottleMs ?? this.cfg.pingThrottleMs!,
      }
      n = new Node<T>(id, nodeCfg, (prev, next) => this.afterCommit(id, prev, next))
      n.init({ data: (opts?.seed ?? {}) as Partial<T> })
      const nextMap = new Map(base)
      nextMap.set(id, n)
      this.nodes.set(nextMap)
      this.emit({ type: 'create', id, now: Date.now(), next: n.state() })
      if (opts?.onFirstCreate) opts.onFirstCreate(this.wrap(n))
    } else {
      if (touch) n.touch()
      if (ping) n.ping()
    }

    return this.wrap(n)
  }

  get<T extends object = Record<string, unknown>>(id: string): SessionHandle<T> | undefined {
    const n = this.nodes().get(id) as Node<T> | undefined
    return n ? this.wrap(n) : undefined
  }

  has(id: string): boolean { return this.nodes().has(id) }

  remove(id: string): boolean {
    return this.removeInternal(id, false /* expired */)
  }

  with<TData extends object, R>(
    id: string,
    fn: (h: SessionHandle<TData>) => R,
    opts?: { createIfMissing?: () => Partial<TData> }
  ): R {
    let n = this.nodes().get(id) as Node<TData> | undefined
    if (!n) {
      const seed = opts?.createIfMissing?.()
      if (!seed) throw new Error(`[session] not found: ${id}`)
      n = this.open<TData>(id, { seed }) as any as Node<TData>
    }
    n.beginBatch()
    try {
      return fn(this.wrap(n))
    } finally {
      n.endBatch()
    }
  }

  cas<T extends object>(
    id: string,
    expectedRev: number,
    next: (prev: Readonly<SessionState<T>>) => Partial<T> | T
  ): boolean {
    const n = this.nodes().get(id) as Node<T> | undefined
    if (!n) return false
    return n.cas(expectedRev, next)
  }

  query(
    predicate?: (s: SessionState<any>) => boolean,
    limit = Number.POSITIVE_INFINITY,
    sort?: (a: SessionState<any>, b: SessionState<any>) => number
  ): ReadonlyArray<SessionState<any>> {
    const out: SessionState<any>[] = []
    for (const n of this.nodes().values()) {
      const s = n.state()
      if (!predicate || predicate(s)) {
        out.push(s)
        if (out.length >= limit) break
      }
    }
    if (sort) out.sort(sort)
    return out
  }

  queryHandles<T extends object = Record<string, unknown>>(
    predicate?: (s: SessionState<T>) => boolean,
    limit = Number.POSITIVE_INFINITY
  ): ReadonlyArray<SessionHandle<T>> {
    const out: SessionHandle<T>[] = []
    for (const n of this.nodes().values()) {
      const s = n.state() as SessionState<T>
      if (!predicate || predicate(s)) {
        out.push(this.wrap(n as Node<T>))
        if (out.length >= limit) break
      }
    }
    return out
  }

  select<T>(id: string, selector: (s: SessionState<any>) => T): ReadonlySignal<T> | undefined {
    const node = this.nodes().get(id)
    if (!node) return undefined
    return computed(() => selector(node.state()))
  }

  selectQuery(
    predicate?: (s: SessionState<any>) => boolean,
    limit = Number.POSITIVE_INFINITY,
    sort?: (a: SessionState<any>, b: SessionState<any>) => number
  ): ReadonlySignal<ReadonlyArray<SessionState<any>>> {
    return computed(() => {
      const arr: SessionState<any>[] = []
      for (const n of this.nodes().values()) {
        const s = n.state()
        if (!predicate || predicate(s)) {
          arr.push(s)
          if (arr.length >= limit) break
        }
      }
      if (sort) arr.sort(sort)
      return arr
    })
  }

  createIndex<K extends string | number | symbol>(
    keyFn: (s: SessionState<any>) => K | K[]
  ) {
    const index = computed(() => {
      const m = new Map<K, Set<string>>()
      for (const [id, n] of this.nodes()) {
        const keys = keyFn(n.state())
        const list = Array.isArray(keys) ? keys : [keys]
        for (const k of list) {
          const set = m.get(k) ?? (m.set(k, new Set()), m.get(k)!)
          set.add(id)
        }
      }
      return m
    })
    const root = effectScope()
    return {
      get: (key: K): ReadonlySet<string> => index().get(key) ?? EMPTY_SET,
      size: (key: K): number => (index().get(key)?.size ?? 0),
      select: (key: K): ReadonlySignal<ReadonlySet<string>> =>
        computed(() => index().get(key) ?? EMPTY_SET),
      dispose: () => root.stop(),
    }
  }

  setOverflowPolicy(policy: OverflowPolicy): void {
    this.overflowPolicy = policy
  }

  on<E extends SessionEvent['type']>(type: E, cb: (e: Extract<SessionEvent, { type: E }>) => void): Stop {
    const set = this.listeners.get(type) ?? (this.listeners.set(type, new Set()), this.listeners.get(type)!)
    set.add(cb)
    return () => { set.delete(cb); if (set.size === 0) this.listeners.delete(type) }
  }

  /* ── internals ── */

  private wrap<T extends object>(n: Node<T>): SessionHandle<T> {
    const ensureAlive = () => {
      if (this.nodes().get(n.id) !== n) throw new Error(`[session] stale handle: ${n.id}`)
    }
    return {
      id: n.id,
      get: () => { ensureAlive(); return n.state() },
      get rev() { ensureAlive(); return n.state().rev },
      patch: (p) => { ensureAlive(); n.patch(p) },
      updateData: (fn) => { ensureAlive(); n.updateData(fn) },
      setAt: (path, value) => { ensureAlive(); n.setAt(path, value) },
      ping: (opts) => { ensureAlive(); n.ping(!!opts?.force) },
      stop: () => { this.remove(n.id) },
    }
  }

  private ensureCapacityOrEvict() {
    const size = this.nodes().size
    if (size < this.cfg.maxSessions!) return
    const now = Date.now()

    const pick = ((): string | undefined => {
      const policy = this.overflowPolicy
      if (policy === 'reject') return undefined
      const snap = Array.from(this.nodes().values()).map(n => n.state())
      if (policy === 'evict_lru') {
        snap.sort((a, b) => a.lastAccess - b.lastAccess)
        return snap[0]?.id
      }
      if (policy === 'evict_idle') {
        const idle = snap.filter(s => !s.online || (now - s.lastPing) > this.cfg.idleMs!)
        if (idle.length) {
          idle.sort((a, b) => a.lastAccess - b.lastAccess)
          return idle[0].id
        }
        // 退化为 LRU
        snap.sort((a, b) => a.lastAccess - b.lastAccess)
        return snap[0]?.id
      }
      // 自定义
      return (policy as any).pickVictim?.({ now, nodes: snap })
    })()

    if (!pick) throw new Error(`[session] capacity exceeded(${size}/${this.cfg.maxSessions})`)
    this.removeInternal(pick, false)
  }

  private removeInternal(id: string, expired: boolean): boolean {
    const base = this.nodes()
    const node = base.get(id)
    if (!node) return false

    const prev = node.state()
    const next = new Map(base)
    next.delete(id)
    this.nodes.set(next)

    if (expired) this.emit({ type: 'expire', id, now: Date.now(), prev })
    this.emit({ type: 'remove', id, now: Date.now(), prev })
    return true
  }

  private afterCommit<T extends object>(id: string, prev: SessionState<T> | null, next: SessionState<T>) {
    if (!prev) return // create 时已单独发 create
    if (prev.online !== next.online) {
      this.emit({ type: next.online ? 'online' : 'offline', id, now: Date.now(), prev, next })
    }
    if (prev.data !== next.data) {
      this.emit({ type: 'updateData', id, now: Date.now(), prev, next })
    }
  }

  private emit(e: SessionEvent) {
    const ls = this.listeners.get(e.type)
    if (!ls || ls.size === 0) return
    for (const cb of ls) {
      try { (cb as any)(e) } catch (err) {
        this.ctx.logger?.error?.(err, `[session] event listener error: ${e.type}`)
      }
    }
  }
}
