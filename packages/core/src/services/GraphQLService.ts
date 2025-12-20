import { type Context, Injectable } from '@pluxel/context'

const serviceName = 'graphql' as const

declare module '@pluxel/context' {
	export interface Context {
		[serviceName]: GraphQLService
	}
	export namespace Context {
		interface Config {
			[serviceName]?: GraphQLConfig
		}
	}
}

export type GraphQLResolver = unknown
export type GraphQLMiddleware = unknown

export type GraphQLModule = {
	resolvers: readonly GraphQLResolver[]
	middlewares?: readonly GraphQLMiddleware[]
}
export type GraphQLModuleInput = GraphQLModule | GraphQLResolver | readonly GraphQLResolver[]

export interface GraphQLFactory {
	resolver: (...args: any[]) => any
	query: (...args: any[]) => any
	mutation: (...args: any[]) => any
}

export interface GraphQLConfig {
	endpoint?: string
	destination?: string
	react?: boolean
	scalarTypes?: Record<string, string>
	factory?: GraphQLFactory
	valibot?: unknown
}

const EMPTY_FACTORY: GraphQLFactory = {
	resolver: () => {
		throw new Error('GraphQL factory not configured')
	},
	query: () => {
		throw new Error('GraphQL factory not configured')
	},
	mutation: () => {
		throw new Error('GraphQL factory not configured')
	},
}

function isGraphQLModule(x: unknown): x is GraphQLModule {
	return !!x && typeof x === 'object' && 'resolvers' in (x as any)
}

function normalizeModule(mod: GraphQLModuleInput): GraphQLModule {
	if (Array.isArray(mod)) return { resolvers: mod }
	if (isGraphQLModule(mod)) {
		return { resolvers: mod.resolvers ?? [], middlewares: mod.middlewares ?? [] }
	}
	return { resolvers: [mod] }
}

@Injectable({ key: serviceName })
export class GraphQLService {
	protected readonly modules = new Map<string | symbol, GraphQLModule>()
	protected readonly globals = new Set<GraphQLMiddleware>()
	protected rebuildPending = false
	protected rebuildDirty = false
	protected config: GraphQLConfig
	protected factoryRef: GraphQLFactory = EMPTY_FACTORY
	protected valibotRef: unknown

	constructor(protected readonly ctx: Context, config: GraphQLConfig = {}) {
		this.config = config
		if (config.factory) this.factoryRef = config.factory
		if (config.valibot) this.valibotRef = config.valibot
	}

	get factory() {
		return this.factoryRef
	}

	get valibot() {
		return this.valibotRef
	}

	useGlobal(mw: GraphQLMiddleware) {
		this.globals.add(mw)
		this.scheduleRebuild()
		const dispose = () => {
			if (this.globals.delete(mw)) this.scheduleRebuild()
		}
		const collect = (this.ctx as Context & { collectEffect?: (fn: () => void) => () => void })
			.collectEffect
		return collect ? collect.call(this.ctx, dispose) : dispose
	}

	useModule(mod: GraphQLModuleInput, key: string | symbol = Symbol('gql-mod')) {
		this.modules.set(key, normalizeModule(mod))
		this.scheduleRebuild()
		const dispose = () => {
			if (this.modules.delete(key)) this.scheduleRebuild()
		}
		const collect = (this.ctx as Context & { collectEffect?: (fn: () => void) => () => void })
			.collectEffect
		return collect ? collect.call(this.ctx, dispose) : dispose
	}

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
		this.onRebuild()
	}

	snapshotModules(): GraphQLModule[] {
		return Array.from(this.modules.values())
	}

	snapshotGlobals(): GraphQLMiddleware[] {
		return Array.from(this.globals.values())
	}

	protected onRebuild(): void {}

	protected setFactory(factory: GraphQLFactory) {
		this.factoryRef = factory
	}

	protected setValibot(valibot: unknown) {
		this.valibotRef = valibot
	}
}
