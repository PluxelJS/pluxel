// src/services/hono/GraphQLService.ts

import { type Middleware, mutation, query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import { generateClient } from '@gqty/cli'
import { Injectable, type Context as PlxContext } from '@pluxel/core'
import { type GraphQLSchema, type OperationDefinitionNode, parse } from 'graphql'
import { createYoga, type Plugin, type YogaInitialContext } from 'graphql-yoga'
import * as v from 'valibot'
import type { AuthGuardResult } from './AuthGuardService'

// -------------------- Config (Valibot) --------------------
const serviceName = 'graphql' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: GraphQLService
	}
	namespace Context {
		interface Config {
			[serviceName]: GraphQLConfig
		}
	}
}

interface GraphQLConfig {
	endpoint: string
	destination?: string
	react: boolean
	scalarTypes: Record<string, string>
}
const _DEFAULT_CONFIG: GraphQLConfig = {
	endpoint: 'http://localhost:3000/graphql',
	destination: undefined,
	react: true,
	scalarTypes: { Number: 'number', Object: 'Record<string, unknown>' },
}

// -------------------- Context Typings --------------------
export type FullCtx = YogaInitialContext & ServerCtx
type ServerCtx = {}

// -------------------- Module Types --------------------
type GqlModule = { resolvers: readonly Resolver[]; middlewares?: readonly Middleware[] }
type GqlModuleInput = GqlModule | Resolver | readonly Resolver[]
type YogaGraphQLParams = { query?: string | null; operationName?: string | null }

interface GraphQLOperationDescriptor {
	type: OperationDefinitionNode['operation']
	name: string | null
	rootFields: readonly string[]
}

interface GraphQLGuardContext {
	operationName: string | null
	operations: readonly GraphQLOperationDescriptor[]
}

interface GraphQLGuardResponseMeta extends GraphQLGuardContext {
	path: string
	method: string
}

function isGqlModule(x: unknown): x is GqlModule {
	return !!x && typeof x === 'object' && 'resolvers' in (x as any)
}

function normalizeModule(mod: GqlModuleInput): GqlModule {
	if (Array.isArray(mod)) return { resolvers: mod }
	if (isGqlModule(mod))
		return { resolvers: mod.resolvers ?? [], middlewares: mod.middlewares ?? [] }
	return { resolvers: [mod as Resolver] }
}

// -------------------- GraphQL Service --------------------
@Injectable({ key: serviceName })
export class GraphQLService {
	// 注册表
	private readonly modules = new Map<string | symbol, GqlModule>()
	private readonly globals = new Set<Middleware>()
	private readonly logger: NonNullable<PlxContext['logger']>

	// 当前 GraphQLSchema（确保类型稳定）
	private schema: GraphQLSchema = this.weaveSchema()

	// 重建批处理
	private rebuildPending = false
	private rebuildDirty = false

	// codegen 并发闸
	private codegenRunning = false

	constructor(
		private readonly ctx: PlxContext,
		private config: GraphQLConfig = _DEFAULT_CONFIG,
	) {
		this.config = { ..._DEFAULT_CONFIG, ...config }
		this.logger = ctx.logger!
	}

	// -------- 对外 API --------
	get valibot() {
		return v
	}
	get factory() {
		return { resolver, query, mutation }
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

	// -------- 内部：重建与推送 --------
	scheduleRebuild() {
		this.rebuildDirty = true
		if (this.rebuildPending) return
		this.rebuildPending = true
		queueMicrotask(() => {
			this.rebuildPending = false
			if (!this.rebuildDirty) return
			this.rebuildNow()
		})
	}

	rebuildNow() {
		this.rebuildDirty = false

		this.schema = this.weaveSchema()
		// Yoga fetch 指针热替换（不重启 Hono）
		this.pushFetch()

		// 不阻塞主线
		void this.codegenNow()
	}

	private weaveSchema() {
		// 聚合 resolvers/middlewares，保持顺序：先基础，再全局，再模块
		const resolvers: Resolver[] = [
			resolver({
				_empty: query(v.string()).resolve(() => 'ok'),
			}),
		]
		const middlewares: Middleware[] = []

		if (this.globals.size) middlewares.push(...this.globals)
		for (const m of this.modules.values()) {
			if (m.resolvers?.length) resolvers.push(...m.resolvers)
			if (m.middlewares?.length) middlewares.push(...m.middlewares)
		}
		// gqloom 的 weave 可以混合放入 Resolver/Middleware；这里显式分组后再展开，便于阅读与调试
		return weave(ValibotWeaver, ...middlewares, ...resolvers)
	}

	/** 用当前 schema 创建 Yoga fetch，并注入 HonoService（仅替换函数指针） */
	private pushFetch() {
		const guardPlugin = this.createAuthGuardPlugin()
		const plugins = guardPlugin ? [guardPlugin] : undefined
		const yoga = createYoga<ServerCtx>({
			landingPage: false,
			graphqlEndpoint: '/graphql',
			maskedErrors: process.env.NODE_ENV === 'production',
			graphiql: process.env.NODE_ENV !== 'production',
			schema: this.schema,
			plugins,
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

	private createAuthGuardPlugin(): Plugin<ServerCtx> | undefined {
		const honoService = this.ctx.honoService
		if (!honoService.isAuthGuardEnabled()) return undefined

		return {
			onParams: async ({ request, params }) => {
				// Fast path: no guards registered yet, skip any parsing work
				if (!honoService.hasAuthGuards()) return

				const requestUrl = this.safeParseUrl(request.url)
				const path = requestUrl?.pathname ?? '/graphql'
				const guardContext = this.extractGraphQLGuardContext((params ?? {}) as YogaGraphQLParams)
				const guardResult = await honoService.evaluateAuthGuard({
					path,
					method: request.method,
					headers: request.headers,
					request,
					url: requestUrl,
					context: Object.freeze({
						type: 'graphql',
						operationName: guardContext.operationName,
						operations: guardContext.operations,
					}),
				})
				if (!guardResult) return

				this.logger.warn('[AuthGuard] Blocked GraphQL request', {
					path,
					method: request.method,
					plugin: guardResult.pluginName,
					reason: guardResult.reason,
					redirect: guardResult.redirectPath,
					operationName: guardContext.operationName,
					operations: guardContext.operations,
				})

				return this.createGraphQLGuardResponse(guardResult, {
					path,
					method: request.method,
					operationName: guardContext.operationName,
					operations: guardContext.operations,
				})
			},
		}
	}

	private extractGraphQLGuardContext(params: YogaGraphQLParams): GraphQLGuardContext {
		const query = params.query ?? ''
		if (!query) {
			return {
				operationName: params.operationName ?? null,
				operations: Object.freeze([]) as readonly GraphQLOperationDescriptor[],
			}
		}

		try {
			const document = parse(query, { noLocation: true })
			const definitions = document.definitions.filter(
				(def): def is OperationDefinitionNode => def.kind === 'OperationDefinition',
			)
			const filtered = params.operationName
				? definitions.filter((op) => op.name?.value === params.operationName)
				: definitions

			const operations = filtered.map<GraphQLOperationDescriptor>((op) => ({
				type: op.operation,
				name: op.name?.value ?? null,
				rootFields: this.collectRootFields(op),
			}))

			const operationName = params.operationName ?? operations[0]?.name ?? null

			return {
				operationName,
				operations: Object.freeze(operations) as readonly GraphQLOperationDescriptor[],
			}
		} catch {
			return {
				operationName: params.operationName ?? null,
				operations: Object.freeze([]) as readonly GraphQLOperationDescriptor[],
			}
		}
	}

	private collectRootFields(op: OperationDefinitionNode): readonly string[] {
		const fields: string[] = []
		for (const selection of op.selectionSet.selections) {
			if (selection.kind === 'Field') {
				fields.push(selection.name.value)
			} else if (selection.kind === 'FragmentSpread') {
				fields.push(`...${selection.name.value}`)
			} else if (selection.kind === 'InlineFragment') {
				const typeCondition = selection.typeCondition?.name?.value
				fields.push(typeCondition ? `... on ${typeCondition}` : '... on <anonymous>')
			}
		}
		return Object.freeze(fields)
	}

	private createGraphQLGuardResponse(
		result: AuthGuardResult,
		meta: GraphQLGuardResponseMeta,
	): Response {
		return new Response(
			JSON.stringify({
				data: null,
				errors: [
					{
						message: 'Access denied',
						extensions: {
							code: 'ACCESS_DENIED',
							pluginName: result.pluginName,
							reason: result.reason ?? null,
							redirectPath: result.redirectPath ?? null,
							path: meta.path,
							method: meta.method,
							operationName: meta.operationName,
							operations: meta.operations,
						},
					},
				],
			}),
			{
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json; charset=utf-8',
				},
			},
		)
	}

	private safeParseUrl(input: string): URL | undefined {
		try {
			return new URL(input)
		} catch {
			return undefined
		}
	}

	// -------- GQty 代码生成：防并发、稳态日志 --------
	private async codegenNow() {
		if (this.codegenRunning) return
		this.codegenRunning = true
		try {
			const cfg = this.config
			if (!cfg.destination) return
			this.logger.info('[GQty] Generating client…', { destination: cfg.destination })

			// generateClient 支持从 schema 直接产出客户端；如需走远端 introspection，可只传 endpoint
			await generateClient(this.schema, {
				endpoint: cfg.endpoint,
				destination: cfg.destination,
				react: cfg.react,
				scalarTypes: cfg.scalarTypes,
			})

			this.logger.info('[GQty] Client generated ✔', { destination: cfg.destination })
		} catch (e) {
			this.logger.error('[GQty] generateClient failed', e)
		} finally {
			this.codegenRunning = false
		}
	}
}
