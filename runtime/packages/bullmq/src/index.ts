// runtime/packages/bullmq/src/index.ts
import { BasePlugin, Config, Plugin, v } from '@pluxel/hmr'
import IORedis, { type RedisOptions } from 'ioredis'
import {
  Queue,
  Worker,
  QueueEvents,
  FlowProducer,
  type JobsOptions,
  type QueueOptions,
  type WorkerOptions
} from 'bullmq'

import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import type { Processor } from 'bullmq/dist/esm/types/processor'

// ============= 多段配置（每段都是 v.object）=============
const RedisConfig = v.object({
  url: v.optional(v.string(), "redis://127.0.0.1:6379"),                                   // redis://user:pass@host:port/db
  lazy: v.optional(v.boolean(), false),
  pingOnStart: v.optional(v.boolean(), true),
  startupTimeoutMs: v.optional(v.number(), 10_000),
  prefix: v.optional(v.string(), 'bull'),
  // 低层 ioredis 可选项（必要时覆盖）
  redisOptions: v.optional(v.record(v.string(), v.unknown()), {} as Record<string, unknown>),
})

const DashboardConfig = v.object({
  enable: v.optional(v.boolean(), false),
  basePath: v.optional(v.string(), '/admin/queues'),
  readOnly: v.optional(v.boolean(), false),
  allowRetries: v.optional(v.boolean(), true)
})

const DefaultsConfig = v.object({
  // 例如给 add() 的默认策略
  removeOnComplete: v.optional(v.union([v.boolean(), v.number()]), true),
  removeOnFail: v.optional(v.union([v.boolean(), v.number()]), false),
})

// ============== 插件实现（仅被 @Plugin 才会被加载）==============
@Plugin({ name: 'BullMQ' })
export class BullMQPlugin extends BasePlugin {
  @Config(RedisConfig)     private redis!: v.InferOutput<typeof RedisConfig>
  @Config(DashboardConfig) private board!: v.InferOutput<typeof DashboardConfig>
  @Config(DefaultsConfig)  private defaults!: v.InferOutput<typeof DefaultsConfig>

  // 共享非阻塞连接（Queue/Worker/Flow 复用）；阻塞连接（Events 专用）
  private shared?: IORedis
  private blockings = new Set<IORedis>()

  // 资源缓存
  private queues = new Map<string, Queue>()
  private workersAny = new Map<string, Worker<any, any, string>>() // 类型擦除存放
  private eventsMap = new Map<string, QueueEvents>()
  private flowProducer?: FlowProducer

  // bull-board 句柄：只存 addQueue 即可
  private addBoardQueue?: (adapter: any) => void
  private serverAdapter?: HonoAdapter

  // 直接访问共享 redis
  get redisClient(): IORedis {
    if (!this.shared) throw new Error('[BullMQ] shared connection not established')
    return this.shared
  }

  // -------- 生命周期：init/stop --------
  override async init(abort: AbortSignal): Promise<void> {
    if (!this.redis.lazy) {
      await this.raceAbortAndTimeout(abort, this.ensureSharedReady(), this.redis.startupTimeoutMs!)
    }

    if (this.board.enable === false) return
      let adapter: HonoAdapter
      
        try {
          // 动态引入，避免在非 Node 环境硬依赖
          const mod = await import('@hono/node-server/serve-static')
          adapter = new HonoAdapter(mod.serveStatic)
        } catch {
          throw new Error("不应该在非 NODE 环境启用")
        }
      
      const basePath = this.board.basePath ?? '/admin/queues'
      adapter.setBasePath(basePath)

      const { addQueue } = createBullBoard({
        queues: [], // 动态注册
        serverAdapter: adapter,
        options: {
          uiConfig: {
            boardTitle: 'Bull Dashboard',
            boardLogo: undefined,
          },
        },
      })
      this.addBoardQueue = addQueue
      this.serverAdapter = adapter

      // 将 bull-board 子应用挂到现有 Hono 实例
      this.ctx.honoService.modifyApp((app) => {
        app.route(basePath, adapter.registerPlugin())
      })

  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.workersAny.values()].map((w) => w.close()))
    await Promise.allSettled([...this.eventsMap.values()].map((e) => e.close()))
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()))
    if (this.flowProducer) { await this.flowProducer.close().catch(() => {}); this.flowProducer = undefined }

    this.workersAny.clear()
    this.eventsMap.clear()
    this.queues.clear()

    await Promise.allSettled(
      [...this.blockings].map(async (c) => {
        this.blockings.delete(c)
        try { await c.quit() } catch { try { c.disconnect() } catch {} }
      }),
    )

    const c = this.shared
    this.shared = undefined
    if (c) { try { await c.quit() } catch { try { c.disconnect() } catch {} } }

    this.addBoardQueue = undefined
    this.serverAdapter = undefined
  }

  // -------- 对外 API --------

  queue(name: string, opts?: Omit<QueueOptions, 'connection' | 'prefix'>): Queue {
    const hit = this.queues.get(name)
    if (hit) return hit
    const q = new Queue(name, {
      ...(opts ?? {}),
      prefix: this.redis.prefix,
      connection: this.getOrCreateShared(),
    })
    this.queues.set(name, q)

    // 若已启用 dashboard，则动态注册
    if (this.addBoardQueue) {
      this.addBoardQueue(
        new BullMQAdapter(q, {
          readOnlyMode: !!this.board.readOnly,
          allowRetries: this.board.allowRetries !== false,
        }),
      )
    }
    return q
  }

  async add<T = any>(
    jobName: string,
    data: T,
    opts?: JobsOptions & { queueName?: string },
  ) {
    const queueName = opts?.queueName ?? jobName
    const q = this.queue(queueName)
    return q.add(jobName, data, {
      removeOnComplete: this.defaults.removeOnComplete,
      removeOnFail: this.defaults.removeOnFail,
      ...opts,
    })
  }

  worker<T = any, R = any, N extends string = string>(
    queueName: string,
    processor: Processor<T, R, N>,
    opts?: Omit<WorkerOptions, 'connection' | 'prefix'>,
  ): Worker<T, R, N> {
    // 以“队列名 + 并发 + 处理器引用”作为去重 key
    const key = `${queueName}:${opts?.concurrency ?? 'default'}:${String(processor)}`
    const cached = this.workersAny.get(key) as unknown as Worker<T, R, N> | undefined
    if (cached) return cached
    const w = new Worker<T, R, N>(queueName, processor, {
      ...(opts ?? {}),
      prefix: this.redis.prefix,
      connection: this.getOrCreateShared(),
    })
    this.workersAny.set(key, w as unknown as Worker<any, any, string>)
    return w
  }

  // QueueEvents（阻塞连接）
  getEvents(queueName: string, opts?: Omit<QueueOptions, 'connection' | 'prefix'>) {
    const key = queueName
    const hit = this.eventsMap.get(key)
    if (hit) return hit
    const e = new QueueEvents(queueName, {
      ...(opts ?? {}),
      prefix: this.redis.prefix,
      connection: this.createBlocking(),
    })
    this.eventsMap.set(key, e)
    return e
  }

  flow(opts?: Omit<QueueOptions, 'connection' | 'prefix'>) {
    if (this.flowProducer) return this.flowProducer
    const fp = new FlowProducer({
      ...(opts ?? {}),
      prefix: this.redis.prefix,
      connection: this.getOrCreateShared(),
    })
    this.flowProducer = fp
    return fp
  }

  // -------- 内部：连接 & 启动校验 --------
  private getOrCreateShared(): IORedis {
    if (this.shared) return this.shared
    const base: RedisOptions = {
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 10_000,
      ...(this.redis.redisOptions as RedisOptions),
    }
    const c = new IORedis(this.redis.url, base)
    c.on('error', (e) => this.ctx.logger.error(e))
    c.on('end', () => this.ctx.logger.info('[BullMQ] shared end'))
    c.on('reconnecting', () => this.ctx.logger.info('[BullMQ] shared reconnecting'))
    this.shared = c
    return c
  }

  private createBlocking(): IORedis {
    const base: RedisOptions = {
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 15_000,
      ...(this.redis.redisOptions as RedisOptions),
    }
    const c = new IORedis(this.redis.url, base)
    c.on('error', (e) => this.ctx.logger.error(e))
    c.on('end', () => this.ctx.logger.info('[BullMQ] blocking end'))
    c.on('reconnecting', () => this.ctx.logger.info('[BullMQ] blocking reconnecting'))
    this.blockings.add(c)
    return c
  }

  private async ensureSharedReady() {
    const c = this.getOrCreateShared()
    await c.connect()
    if (this.redis.pingOnStart) await c.ping()
  }

  private async raceAbortAndTimeout<T>(
    abort: AbortSignal,
    task: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    if (abort.aborted) throw new Error('[BullMQ] init aborted before start')
    const pAbort = new Promise<never>((_, rej) => {
      const l = () => { abort.removeEventListener('abort', l); rej(new Error('[BullMQ] init aborted')) }
      abort.addEventListener('abort', l)
    })
    const pTimeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('[BullMQ] init timeout')), timeoutMs).unref?.(),
    )
    return Promise.race([task, pAbort, pTimeout])
  }
}
