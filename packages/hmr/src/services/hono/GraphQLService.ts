// src/services/hono/GraphQLService.ts

import { type Middleware, mutation, query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import { generateClient } from '@gqty/cli'
import { Injectable, OverrideOf, type Context as PlxContext } from '@pluxel/core'
import { GraphQLService as CoreGraphQLService, type GraphQLConfig } from '@pluxel/core/services'
import type { GraphQLSchema } from 'graphql'
import { createYoga, type YogaInitialContext } from 'graphql-yoga'
import * as v from 'valibot'

// -------------------- Config (Valibot) --------------------
const _DEFAULT_CONFIG: GraphQLConfig = {
	endpoint: 'http://localhost:3000/graphql',
	react: true,
	scalarTypes: { Number: 'number', Object: 'Record<string, unknown>' },
}

// -------------------- Context Typings --------------------
export type FullCtx = YogaInitialContext & ServerCtx
type ServerCtx = {}

// -------------------- Module Types --------------------
// -------------------- GraphQL Service --------------------
@Injectable
@OverrideOf(CoreGraphQLService)
export class GraphQLService extends CoreGraphQLService {
	private readonly logger: NonNullable<PlxContext['logger']>

	// 当前 GraphQLSchema（确保类型稳定）
	private schema: GraphQLSchema = this.weaveSchema()

	// codegen 并发闸
	private codegenRunning = false

	constructor(ctx: PlxContext, config: GraphQLConfig = _DEFAULT_CONFIG) {
		const merged = { ..._DEFAULT_CONFIG, ...config }
		super(ctx, merged)
		this.logger = ctx.logger!
		if (!merged.factory) this.setFactory({ resolver, query, mutation })
		if (!merged.valibot) this.setValibot(v)
	}

	private weaveSchema() {
		// 聚合 resolvers/middlewares，保持顺序：先基础，再全局，再模块
		const resolvers: Resolver[] = [
			resolver({
				_empty: query(v.string()).resolve(() => 'ok'),
			}),
		]
		const middlewares: Middleware[] = []

		if (this.globals.size) middlewares.push(...(this.globals as Set<Middleware>))
		for (const m of this.modules.values()) {
			if (m.resolvers?.length) resolvers.push(...(m.resolvers as Resolver[]))
			if (m.middlewares?.length) middlewares.push(...(m.middlewares as Middleware[]))
		}
		// gqloom 的 weave 可以混合放入 Resolver/Middleware；这里显式分组后再展开，便于阅读与调试
		return weave(ValibotWeaver, ...middlewares, ...resolvers)
	}

	/** 用当前 schema 创建 Yoga fetch，并注入 HonoService（仅替换函数指针） */
	private pushFetch() {
		const yoga = createYoga<ServerCtx>({
			landingPage: false,
			graphqlEndpoint: '/graphql',
			maskedErrors: process.env.NODE_ENV === 'production',
			graphiql: process.env.NODE_ENV !== 'production',
			schema: this.schema,
			// 强制复用全局 fetch API，避免构建后出现多份 Response 构造器导致 instanceof 失效
			fetchAPI: {
				Response: globalThis.Response,
				Request: globalThis.Request,
				Headers: globalThis.Headers,
			},
		})
		// HonoService 内部声明合并了 setGraphQLFetch，这里避免循环依赖，保留弱类型转发
		const fetcher = (req: Request, ctx: ServerCtx) => yoga.fetch(req, ctx)
		this.ctx.honoService.setGraphQLFetch(fetcher as any)
	}

	protected override onRebuild() {
		this.schema = this.weaveSchema()
		// Yoga fetch 指针热替换（不重启 Hono）
		this.pushFetch()

		// 不阻塞主线
		void this.codegenNow()
	}

	// -------- GQty 代码生成：防并发、稳态日志 --------
	private async codegenNow() {
		if (this.codegenRunning) return
		this.codegenRunning = true
		try {
			const cfg = this.config
			if (!cfg.destination) return
			this.logger.info('Generating GQty client…', { destination: cfg.destination })

			// generateClient 支持从 schema 直接产出客户端；如需走远端 introspection，可只传 endpoint
			await generateClient(this.schema, {
				endpoint: cfg.endpoint,
				destination: cfg.destination,
				react: cfg.react,
				scalarTypes: cfg.scalarTypes,
			})

			this.logger.info('GQty client generated', { destination: cfg.destination })
		} catch (error) {
			this.logger.error('generateClient failed: {error}', { error })
		} finally {
			this.codegenRunning = false
		}
	}
}
