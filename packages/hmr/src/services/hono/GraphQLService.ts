// src/services/hono/GraphQLService.ts

import { type Middleware, mutation, query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import { generateClient } from '@gqty/cli'
import { Injectable, type Context as PlxContext } from '@pluxel/core'
import type { GraphQLSchema } from 'graphql'
import { createYoga, type YogaInitialContext } from 'graphql-yoga'
import * as v from 'valibot'
import type { AppEnv } from './env'

// -------------------- Config (Valibot) --------------------
const SubscriptionsSchema = v.union([
	v.literal(false),
	v.literal('graphql-ws'),
	v.literal('graphql-sse'),
])

const GQtyConfigSchema = v.object({
	endpoint: v.fallback(v.optional(v.string()), 'http://localhost:3000/graphql'),
	destination: v.fallback(v.optional(v.string()), './src/app/gqty/index.ts'),
	react: v.fallback(v.optional(v.boolean()), true),
	subscriptions: v.fallback(v.optional(SubscriptionsSchema), false),
	// 标量映射给默认值，常用即可，随时可在外部覆写
	scalarTypes: v.fallback(v.optional(v.record(v.string(), v.string())), {
		Number: 'number',
		Object: 'Record<string, unknown>',
	}),
})

const GraphQLConfigSchema = v.object({
	gqty: v.fallback(v.optional(GQtyConfigSchema), {
		endpoint: 'http://localhost:3000/graphql',
		destination: './src/app/gqty/index.ts',
		react: true,
		subscriptions: false,
		scalarTypes: { Number: 'number', Object: 'Record<string, unknown>' },
	}),
})

type InternalGQtyCfg = v.InferFallbacks<typeof GQtyConfigSchema>
type GraphQLCfgInput = v.InferInput<typeof GraphQLConfigSchema>

// -------------------- Context Typings --------------------
export type FullCtx = YogaInitialContext & { hono: import('hono').Context<AppEnv> }
type ServerCtx = { hono: import('hono').Context<AppEnv> }

// -------------------- Module Types --------------------
type GqlModule = { resolvers: readonly Resolver[]; middlewares?: readonly Middleware[] }
type GqlModuleInput = GqlModule | Resolver | readonly Resolver[]

function isGqlModule(x: unknown): x is GqlModule {
	return !!x && typeof x === 'object' && 'resolvers' in (x as any)
}

function normalizeModule(mod: GqlModuleInput): GqlModule {
	if (Array.isArray(mod)) return { resolvers: mod }
	if (isGqlModule(mod))
		return { resolvers: mod.resolvers ?? [], middlewares: mod.middlewares ?? [] }
	return { resolvers: [mod as Resolver] }
}

// -------------------- Base Resolver (健康检查) --------------------
const baseResolver: Resolver = resolver({
	_empty: query(v.string()).resolve(() => 'ok'),
})

// -------------------- GraphQL Service --------------------
@Injectable({ key: 'graphqlService' })
export class GraphQLService {
	// 注册表
	private readonly modules = new Map<string | symbol, GqlModule>()
	private readonly globals = new Set<Middleware>()

	// 当前 GraphQLSchema（确保类型稳定）
	private schema: GraphQLSchema = weave(ValibotWeaver, baseResolver)

	// 重建批处理
	private rebuildPending = false
	private rebuildDirty = false

	// codegen 并发闸
	private codegenRunning = false

	// 配置（带 fallback）
	private readonly gqtyCfg: InternalGQtyCfg

	constructor(
		private readonly ctx: PlxContext,
		config: GraphQLCfgInput = {},
	) {
		const parsed = v.safeParse(GraphQLConfigSchema, config)
		if (parsed.success) {
			this.gqtyCfg = parsed.output.gqty as any
		} else {
			this.logger.error?.('[GraphQLService] Invalid GraphQLConfig', parsed.issues)
			this.gqtyCfg = v.parse(GraphQLConfigSchema, {}).gqty as any
		}

		// 冷启动先推一次 fetch，避免 HonoService 未就绪/返回 503
		this.pushFetch()
	}

	// 统一 logger（优先 ctx.logger）
	private get logger() {
		return (this.ctx as any).logger ?? console
	}

	// -------- 对外 API --------
	get valibot() {
		return v
	}
	get factory() {
		return { resolver, query, mutation }
	}
	getSchema() {
		return this.schema
	}

	/** 挂全局中间件（自动去重 + 可撤销） */
	useGlobal(mw: Middleware) {
		this.globals.add(mw)
		this.scheduleRebuild()
		return this.ctx.scope.collectEffect(() => {
			if (this.globals.delete(mw)) this.scheduleRebuild()
		})
	}

	/** 挂模块（Resolver[]/Resolver/GqlModule，支持 key 覆盖 + 可撤销） */
	useModule(mod: GqlModuleInput, key: string | symbol = Symbol('gql-mod')) {
		this.modules.set(key, normalizeModule(mod))
		this.scheduleRebuild()
		return this.ctx.scope.collectEffect(() => {
			if (this.modules.delete(key)) this.scheduleRebuild()
		})
	}

	/** 立即重建（同步 flush） */
	flush() {
		if (this.rebuildDirty) this.rebuildNow()
	}

	// -------- 内部：重建与推送 --------
	private scheduleRebuild() {
		this.rebuildDirty = true
		if (this.rebuildPending) return
		this.rebuildPending = true
		queueMicrotask(() => {
			this.rebuildPending = false
			if (!this.rebuildDirty) return
			this.rebuildNow()
		})
	}

	private rebuildNow() {
		this.rebuildDirty = false

		// 聚合 resolvers/middlewares，保持顺序：先基础，再全局，再模块
		const resolvers: Resolver[] = [baseResolver]
		const middlewares: Middleware[] = []

		if (this.globals.size) middlewares.push(...this.globals)
		for (const m of this.modules.values()) {
			if (m.resolvers?.length) resolvers.push(...m.resolvers)
			if (m.middlewares?.length) middlewares.push(...m.middlewares)
		}

		// gqloom 的 weave 可以混合放入 Resolver/Middleware；这里显式分组后再展开，便于阅读与调试
		this.schema = weave(ValibotWeaver, ...middlewares, ...resolvers)

		// Yoga fetch 指针热替换（不重启 Hono）
		this.pushFetch()

		// 不阻塞主线
		void this.codegenNow()
	}

	/** 用当前 schema 创建 Yoga fetch，并注入 HonoService（仅替换函数指针） */
	private pushFetch() {
		const yoga = createYoga<ServerCtx>({
			landingPage: false,
			graphqlEndpoint: '/graphql',
			maskedErrors: process.env.NODE_ENV === 'production',
			graphiql: process.env.NODE_ENV !== 'production',
			schema: this.schema,
		})
		// HonoService 内部声明合并了 setGraphQLFetch，这里避免循环依赖，保留弱类型转发
		const fetcher = (req: Request, ctx: ServerCtx) => yoga.fetch(req, ctx)
		;(this.ctx as any).honoService?.setGraphQLFetch(fetcher)
	}

	// -------- GQty 代码生成：防并发、稳态日志 --------
	private async codegenNow() {
		if (this.codegenRunning) return
		this.codegenRunning = true
		try {
			const cfg = this.gqtyCfg
			this.logger.info?.('[GQty] Generating client…', { destination: cfg.destination })

			// generateClient 支持从 schema 直接产出客户端；如需走远端 introspection，可只传 endpoint
			await generateClient(this.schema, {
				endpoint: cfg.endpoint,
				destination: cfg.destination,
				react: cfg.react,
				subscriptions: cfg.subscriptions,
				scalarTypes: cfg.scalarTypes,
			})

			this.logger.info?.('[GQty] Client generated ✔', { destination: cfg.destination })
		} catch (e) {
			this.logger.error?.('[GQty] generateClient failed', e)
		} finally {
			this.codegenRunning = false
		}
	}
}
