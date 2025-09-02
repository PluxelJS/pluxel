// runtime/packages/influxdb/src/index.ts
import { type Awaitable, BasePlugin, Config, Plugin, v } from '@pluxel/hmr'

/* ──────────────────────────── Configs ──────────────────────────── */

export const ConnCfg = v.object({
  /** InfluxDB URL，例如 http://localhost:8086 */
  url: v.optional(v.string(), 'http://localhost:8086'),
  /** 访问 Token（必填） */
  token: v.string(),
  /** 组织名 */
  org: v.optional(v.string(), 'default'),
  /** 默认写入 bucket */
  bucket: v.optional(v.string(), 'default'),
})
export type ConnCfg = v.InferOutput<typeof ConnCfg>

export const WriteCfg = v.object({
  /** flush 周期（ms） */
  flushIntervalMs: v.optional(v.number(), 1_000),
  /** 批大小（行） */
  batchSize: v.optional(v.number(), 5_000),
  /** 精度：ns/us/ms/s */
  precision: v.optional(v.picklist(['ns', 'us', 'ms', 's']), 'ns'),
  /** 最大重试次数 */
  maxRetries: v.optional(v.number(), 5),
  /** 退避区间（ms） */
  minRetryDelayMs: v.optional(v.number(), 500),
  maxRetryDelayMs: v.optional(v.number(), 30_000),
  /** 开启 Gzip 压缩 */
  gzip: v.optional(v.boolean(), true),
  /** 默认 tags（调用方会与之合并） */
  defaultTags: v.optional(v.record(v.string(), v.string()), {}),
})
export type WriteCfg = v.InferOutput<typeof WriteCfg>

export const AgentCfg = v.object({
  /** 复用连接 */
  keepAlive: v.optional(v.boolean(), true),
  /** 最大并发连接 */
  maxSockets: v.optional(v.number(), 512),
  /** 最大空闲连接 */
  maxFreeSockets: v.optional(v.number(), 64),
})
export type AgentCfg = v.InferOutput<typeof AgentCfg>

export const BackpressureCfg = v.object({
  /** 触发回压的近似本地缓冲高水位（行） */
  highWatermark: v.optional(v.number(), 200_000),
  /**
   * 回压策略：
   * - drop  : 丢弃新写入（记日志，不阻塞）
   * - block : 最多轻阻塞 200ms，等待缓冲下降
   */
  policy: v.optional(v.picklist(['drop', 'block']), 'drop'),
})
export type BackpressureCfg = v.InferOutput<typeof BackpressureCfg>

/* ──────────────────────────── Types ──────────────────────────── */

import type {
  InfluxDB as InfluxDBClient,
  Point as InfluxPoint,
  QueryApi,
  WriteApi,
  WriteOptions,
  FluxTableMetaData,
  Transport,
} from '@influxdata/influxdb-client'
import { InfluxDB, Point } from '@influxdata/influxdb-client'

/* ──────────────────────────── Plugin ──────────────────────────── */

@Plugin({ name: 'InfluxDB' })
export class InfluxDBPlugin extends BasePlugin {
  /** 连接配置（token 必填，其余有默认） */
  @Config(ConnCfg) private conn!: ConnCfg
  /** 写入配置 */
  @Config(WriteCfg) private write!: WriteCfg
  /** Node Agent 配置 */
  @Config(AgentCfg) private agent!: AgentCfg
  /** 软回压配置 */
  @Config(BackpressureCfg) private bp!: BackpressureCfg

  // 运行期对象
  private _client!: InfluxDBClient
  private _writeApi!: WriteApi
  private _queryApi!: QueryApi
  private _PointCtor!: { new (m: string): InfluxPoint }

  private _healthy = false
  private _closing = false
  private _approxBuffered = 0 // 近似统计：本地积压行数

  /* ─────────────── lifecycle ─────────────── */

  async init(_abort: AbortSignal): Promise<void> {
    this._PointCtor = Point

    // Keep-Alive Agent（http/https）
    const isHttps = this.conn.url.startsWith('https:')
    const agentCtor = isHttps ? (await import('https')).Agent : (await import('http')).Agent
    const httpAgent = new agentCtor({
      keepAlive: this.agent.keepAlive,
      maxSockets: this.agent.maxSockets,
      maxFreeSockets: this.agent.maxFreeSockets,
    })

    this._client = new InfluxDB({
      url: this.conn.url,
      token: this.conn.token,
      transportOptions: { agent: httpAgent },
    })

    this._writeApi = this._client.getWriteApi(
      this.conn.org,
      this.conn.bucket,
      this.write.precision,
      this._toWriteOptions(this.write),
    )
    if (this.write.defaultTags && Object.keys(this.write.defaultTags).length) {
      this._writeApi.useDefaultTags(this.write.defaultTags)
    }

    this._queryApi = this._client.getQueryApi(this.conn.org)

    // 轻量健康探测
    try {
      await this.query('buckets() |> limit(n:1)')
      this._healthy = true
      this.ctx.logger.info('[InfluxDB] initialized')
    } catch (e) {
      this._healthy = false
      this.ctx.logger.error(e, '[InfluxDB] init failed')
      throw e
    }
  }

  async stop(_abort: AbortSignal): Promise<void> {
    this._closing = true
    try {
      await this.flush(true)
      await this._writeApi.close().catch(() => {})
      this._healthy = false
      this.ctx.logger.info('[InfluxDB] stopped')
    } finally {
      this._approxBuffered = 0
    }
  }

  /* ─────────────── raw exposure ─────────────── */

  /** 原生 InfluxDB 客户端 */
  get client(): InfluxDBClient {
    return this._client
  }

  /** 原生 QueryApi */
  getQueryApi(): QueryApi {
    return this._queryApi
  }

  /** Point 构造器（原生 DSL） */
  get Point(): { new (m: string): InfluxPoint } {
    return this._PointCtor
  }

  /**
   * 获取一个新的 WriteApi（按需覆盖默认参数）
   */
  createWriteApi(opts?: {
    bucket?: string
    precision?: 'ns' | 'us' | 'ms' | 's'
    write?: Partial<WriteCfg>
    defaultTags?: Record<string, string>
  }): WriteApi {
    const bucket = opts?.bucket ?? this.conn.bucket
    const precision = opts?.precision ?? this.write.precision
    const mergedWrite: WriteCfg = { ...this.write, ...(opts?.write ?? {}) }
    const wa = this._client.getWriteApi(this.conn.org, bucket, precision, this._toWriteOptions(mergedWrite))
    const tags = { ...this.write.defaultTags, ...(opts?.defaultTags ?? {}) }
    if (Object.keys(tags).length) wa.useDefaultTags(tags)
    return wa
  }

  /* ─────────────── high-level write ─────────────── */

  /**
   * 便捷写入：measurement + fields + tags + ts
   * - timestamp 完全贴合官方：仅接受 string | number | Date
   */
  async writeObject(
    measurement: string,
    fields: Record<string, number | string | boolean>,
    tags?: Record<string, string>,
    timestamp?: string | number | Date,
  ): Promise<void> {
    if (!this._shouldAccept(1)) return
    const p = new this._PointCtor(measurement)
    if (tags) for (const [k, v] of Object.entries(tags)) p.tag(k, String(v))
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'number') p.floatField(k, v)
      else if (typeof v === 'boolean') p.booleanField(k, v)
      else p.stringField(k, String(v))
    }
    if (timestamp != null) p.timestamp(timestamp) // 只喂 string|number|Date
    this._approxBuffered++
    this._writeApi.writePoint(p)
    this._postWriteTick()
  }

  /** 写入原生 Point */
  async writePoint(point: InfluxPoint): Promise<void> {
    if (!this._shouldAccept(1)) return
    this._approxBuffered++
    this._writeApi.writePoint(point)
    this._postWriteTick()
  }

  /** 写入行协议（单条或多条） */
  async writeLine(line: string | string[]): Promise<void> {
    const n = Array.isArray(line) ? line.length : 1
    if (!this._shouldAccept(n)) return
    this._approxBuffered += n
    if (Array.isArray(line)) this._writeApi.writeRecords(line)
    else this._writeApi.writeRecord(line)
    this._postWriteTick()
  }

  /** 批量混合写入（Point | 行协议 | 对象）- 仅计数一次，不重复自增 */
  async writeBatch(
    items: Array<
      | InfluxPoint
      | string
      | {
          measurement: string
          fields: Record<string, number | string | boolean>
          tags?: Record<string, string>
          timestamp?: string | number | Date
        }
    >,
  ): Promise<void> {
    const n = items.length
    if (!this._shouldAccept(n)) return
    this._approxBuffered += n

    for (const it of items) {
      if (typeof it === 'string') {
        this._writeApi.writeRecord(it)
        continue
      }
      if (typeof (it as any).floatField === 'function') {
        this._writeApi.writePoint(it as InfluxPoint)
        continue
      }
      const { measurement, fields, tags, timestamp } = it as any
      const p = new this._PointCtor(measurement)
      if (tags) for (const [k, v] of Object.entries(tags)) p.tag(k, String(v))
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'number') p.floatField(k, v)
        else if (typeof v === 'boolean') p.booleanField(k, v)
        else p.stringField(k, String(v))
      }
      if (timestamp != null) p.timestamp(timestamp)
      this._writeApi.writePoint(p)
    }
    this._postWriteTick()
  }

  /** 显式 flush；hard=true 等待网络落盘（stop 时使用） */
  async flush(hard = false): Promise<void> {
    try {
      await this._writeApi.flush(hard)
    } finally {
      // 粗略衰减近似计数，避免长期偏高
      this._approxBuffered = Math.max(0, Math.floor(this._approxBuffered * 0.1))
    }
  }

  /* ─────────────── query ─────────────── */

  /** 小结果集收集 */
  async query<T extends Record<string, any>>(flux: string): Promise<T[]> {
    const out: T[] = []
    await this.queryRows(flux, (o) => {out.push(o as T)})
    return out
  }

  /** 大结果集流式处理 */
  async queryRows(
    flux: string,
    onRow: (row: Record<string, any>) => Awaitable<void>,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this._queryApi.queryRows(flux, {
        next: (row: string[], meta: FluxTableMetaData) => {
          try {
            const r = onRow(meta.toObject(row))
            // 不返回 Promise；如为 Promise，挂错误管道即可
            if (r && typeof (r as any).then === 'function') {
              ;(r as Promise<void>).catch(reject)
            }
          } catch (e) {
            reject(e)
          }
        },
        error: (e) => reject(e),
        complete: () => resolve(),
      })
    })
  }

  /* ─────────────── runtime ops ─────────────── */

  /** 连接健康状态（init 成功后为 true） */
  isHealthy(): boolean {
    return this._healthy
  }

  /** 热切换默认 bucket（灰度/多租户场景） */
  changeDefaultBucket(bucket: string): void {
    try {
      this._writeApi.close().catch(() => {})
    } catch {}
    this.conn = { ...this.conn, bucket }
    this._writeApi = this._client.getWriteApi(
      this.conn.org,
      this.conn.bucket,
      this.write.precision,
      this._toWriteOptions(this.write),
    )
    if (this.write.defaultTags && Object.keys(this.write.defaultTags).length) {
      this._writeApi.useDefaultTags(this.write.defaultTags)
    }
  }

  /** 合并默认 tags（对当前默认 writeApi 生效） */
  mergeDefaultTags(tags: Record<string, string>): void {
    this.write.defaultTags = { ...(this.write.defaultTags ?? {}), ...tags }
    if (Object.keys(this.write.defaultTags).length) {
      this._writeApi.useDefaultTags(this.write.defaultTags)
    }
  }

  /* ─────────────── internals ─────────────── */

  private _toWriteOptions(w: WriteCfg): Partial<WriteOptions> {
    return {
      flushInterval: w.flushIntervalMs,
      batchSize: w.batchSize,
      maxRetries: w.maxRetries,
      minRetryDelay: w.minRetryDelayMs,
      maxRetryDelay: w.maxRetryDelayMs,
      gzipThreshold: w.gzip ? 0 : -1, // 0=总是压缩；-1=禁用
    }
  }

  /** 回压：是否接受写入；block 最多等待 ~200ms */
  private _shouldAccept(n: number): boolean {
    if (this._closing) return false
    const next = this._approxBuffered + n
    if (next <= this.bp.highWatermark) return true

    if (this.bp.policy === 'block') {
      const deadline = Date.now() + 200
      // 轻量 busy-wait（留给事件循环 I/O 时间片）
      // 注意：这是“软阻塞”，目的在于削峰，而非强背压
      while (Date.now() < deadline && this._approxBuffered > Math.floor(this.bp.highWatermark * 0.7)) {
        // 2ms 微睡；使用 setTimeout 不返回值，避免 Awaitable<number> 问题
        const start = Date.now()
        let fired = false
        setTimeout(() => (fired = true), 2)
        // 简易自旋等待
        while (!fired && Date.now() - start < 4) {}
      }
      return true
    }

    this.ctx.logger.warn(
      { approxBuffered: this._approxBuffered, want: n, highWatermark: this.bp.highWatermark },
      '[InfluxDB] local buffer high, drop incoming',
    )
    return false
  }

  /** 写入后异步衰减近似计数（避免热路径上的原子操作） */
  private _postWriteTick(): void {
    setTimeout(() => {
      this._approxBuffered = Math.max(0, Math.floor(this._approxBuffered * 0.98))
    }, 10)
  }
}

/* ──────────────────────────── Usage ────────────────────────────
const influx = ctx.get(InfluxDB)

// 1) 便捷对象写入
await influx.writeObject(
  'http',
  { cost_ms: 12.3, ok: true, route: '/api/x' },
  { svc: 'edge', env: 'prod' },
  Date.now(), // 或 new Date()
)

// 2) 行协议
await influx.writeLine('cpu,host=web01 usage=0.63 1725222222000000000')

// 3) 原生 Point
const p = new influx.Point('mem').tag('host', 'web01').floatField('used', 1024)
await influx.writePoint(p)

// 4) 查询（收集）
const rows = await influx.query<{ _time: string; _value: number }>(`
  from(bucket: "${influx['conn'].bucket}")
    |> range(start: -5m)
    |> filter(fn: (r) => r._measurement == "http" and r.ok == true)
`)

// 5) 临时 WriteApi（覆盖部分参数）
const wa = influx.createWriteApi({ bucket: 'another', write: { batchSize: 10_000 }, defaultTags: { env: 'prod' } })
wa.writeRecord('disk,host=web01 used=71i')
await wa.flush()
wa.close()
*/
