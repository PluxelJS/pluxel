import { BasePlugin, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'

import {
	createGraphQLFetch,
	GraphQLFactory,
	type GraphQLMiddleware,
	type GraphQLModule,
	type GraphQLModuleInput,
	type GraphQLPluginConfig,
	normalizeModule,
	weaveSchema,
} from './service'

const SECTION_CODEGEN = { id: 'codegen', title: 'Codegen', description: 'GQty client generation' }
const SECTION_RUNTIME = { id: 'runtime', title: 'Runtime', description: 'GraphQL server settings' }

const CodegenConfig = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({
			label: 'Enable codegen',
			description: 'Generate GQty client on schema rebuild (dev only).',
			section: SECTION_CODEGEN,
		}),
		f.booleanMeta({}),
	),
	destination: v.pipe(
		v.optional(v.string(), ''),
		f.formMeta({
			label: 'Destination',
			description: 'Output file path for generated client (workspace-relative).',
			section: SECTION_CODEGEN,
		}),
	),
	endpoint: v.pipe(
		v.optional(v.string(), 'http://localhost:3000/graphql'),
		f.formMeta({
			label: 'Endpoint',
			description: 'HTTP endpoint used by codegen (introspection).',
			section: SECTION_CODEGEN,
		}),
	),
})

const DEFAULT_CODEGEN_CONFIG = {
	enabled: false,
	destination: '',
	endpoint: 'http://localhost:3000/graphql',
} as const

const GraphQLConfigSchema = v.object({
	// NOTE: PluginRegistry passes `missingObjectDefault: {}` when a plugin is enabled but has no saved config.
	// Make `codegen` resilient to `{ graphql: {} }` so the builtin can start with an empty config file.
	codegen: v.optional(CodegenConfig, DEFAULT_CODEGEN_CONFIG),
	react: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			label: 'React',
			description: 'Generate React bindings',
			section: SECTION_CODEGEN,
		}),
		f.booleanMeta({}),
	),
	scalarTypes: v.pipe(
		v.optional(v.record(v.string(), v.string()), {}),
		f.formMeta({
			label: 'Scalar types',
			description: 'Scalar mapping for codegen (e.g. { Number: "number" }).',
			section: SECTION_RUNTIME,
		}),
	),
})

type GraphQLPluginConfigShape = v.InferOutput<typeof GraphQLConfigSchema>

@Plugin({ name: 'GraphQL' })
export class GraphQLPlugin extends BasePlugin {
	graphql = this.configs.use(GraphQLConfigSchema)

	readonly factory = GraphQLFactory

	private readonly modules = new Map<string | symbol, GraphQLModule>()
	private readonly globals = new Set<GraphQLMiddleware>()

	private rebuildPending = false
	private rebuildDirty = false

	private schema = weaveSchema({ modules: [], globals: [] })
	private codegenRunning = false

	override init() {
		this.applyConfig(this.graphql)
		this.rebuildNow()
		this.ctx.logger.info('GraphQL builtin ready', {
			codegen: Boolean(this.getConfig().codegen?.enabled && this.getConfig().destination),
		})
	}

	private applyConfig(cfg: GraphQLPluginConfigShape) {
		const codegen = cfg.codegen ?? DEFAULT_CODEGEN_CONFIG
		const destination = codegen.destination?.trim() ? codegen.destination.trim() : undefined
		const endpoint = codegen.endpoint?.trim() ? codegen.endpoint.trim() : undefined

		this.configure({
			codegen: { enabled: Boolean(codegen.enabled) },
			destination,
			endpoint,
			react: cfg.react,
			scalarTypes: cfg.scalarTypes ?? {},
		})
	}

	/**
	 * Register a GraphQL module (resolvers + optional middlewares).
	 *
	 * If called through `features.dep(GraphQLPlugin, ...)`, the disposer is auto-collected into
	 * the caller plugin scope via `dep.ctx.caller`.
	 */
	useModule(mod: GraphQLModuleInput, key: string | symbol = Symbol('gql-mod')): () => void {
		this.modules.set(key, normalizeModule(mod))
		this.scheduleRebuild()

		const dispose = () => {
			if (this.modules.delete(key)) this.scheduleRebuild()
		}

		const collect =
			this.ctx.caller?.scope?.collectEffect ?? this.ctx.scope.collectEffect.bind(this.ctx.scope)
		return collect(dispose)
	}

	useGlobal(mw: GraphQLMiddleware): () => void {
		this.globals.add(mw)
		this.scheduleRebuild()

		const dispose = () => {
			if (this.globals.delete(mw)) this.scheduleRebuild()
		}

		const collect =
			this.ctx.caller?.scope?.collectEffect ?? this.ctx.scope.collectEffect.bind(this.ctx.scope)
		return collect(dispose)
	}

	private config: GraphQLPluginConfig = {}

	getConfig(): Readonly<GraphQLPluginConfig> {
		return this.config
	}

	configure(
		next: GraphQLPluginConfig | ((prev: Readonly<GraphQLPluginConfig>) => GraphQLPluginConfig),
	) {
		const updated = typeof next === 'function' ? next(this.config) : next
		this.config = {
			...(this.config ?? {}),
			...(updated ?? {}),
			codegen: {
				...(this.config?.codegen ?? {}),
				...(updated?.codegen ?? {}),
			},
		}
		this.scheduleRebuild()
	}

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
		this.schema = weaveSchema({ modules: this.modules.values(), globals: this.globals })

		const fetcher = createGraphQLFetch(this.schema)
		this.ctx.honoService.setGraphQLFetch(fetcher)

		void this.codegenNow()
	}

	private async codegenNow() {
		const cfg = this.getConfig()
		if (!cfg.codegen?.enabled) return
		if (!cfg.destination) return
		if (process.env.NODE_ENV === 'production') return
		if (this.codegenRunning) return

		this.codegenRunning = true
		try {
			const destination = cfg.destination
			this.ctx.logger.info('Generating GQty client…', { destination })

			const { generateClient } = await import('@gqty/cli')
			await generateClient(this.schema, {
				endpoint: cfg.endpoint,
				destination,
				react: cfg.react,
				scalarTypes: cfg.scalarTypes,
			})

			this.ctx.logger.info('GQty client generated', { destination })
		} catch (error) {
			this.ctx.logger.error('generateClient failed', { error, destination: cfg.destination })
		} finally {
			this.codegenRunning = false
		}
	}
}

export type {
	GraphQLMiddleware,
	GraphQLModule,
	GraphQLModuleInput,
	GraphQLResolver,
} from './service'

// biome-ignore lint/style/noDefaultExport: plugin ctors are intentionally default-exported for ergonomic host imports.
export default GraphQLPlugin
