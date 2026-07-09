import { Injectable, type Context as PlxContext } from '@pluxel/core'
import { printSchema, type GraphQLSchema } from 'graphql'
import { createYoga } from 'graphql-yoga'

import { RUNTIME_TRANSPORT_PATHS } from '../../web/paths'
import { createElysiaApp } from './elysia'
import { createInternalGraphQLSchema } from './internalGraphqlSchema'

const serviceName = 'internalGraphql' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: InternalGraphQLService
		}
		interface Config {
			[serviceName]?: InternalGraphQLConfig
		}
	}
}

export type InternalGraphQLConfig = {
	codegen?: boolean
}

@Injectable({ key: serviceName })
export class InternalGraphQLService {
	private readonly logger: NonNullable<PlxContext['logger']>
	private readonly config: InternalGraphQLConfig | undefined

	private schema: GraphQLSchema
	private fetcher: (req: Request) => Promise<Response>

	private rebuildPending = false
	private rebuildDirty = false
	private codegenRunning = false

	constructor(
		public ctx: PlxContext,
		cfg?: InternalGraphQLConfig,
	) {
		this.logger = ctx.logger!
		this.config = cfg
		this.schema = createInternalGraphQLSchema(ctx)
		this.fetcher = async () => new Response('Internal GraphQL not ready', { status: 503 })
		this.pushFetch()
		this.scheduleRebuild()
	}

	fetch(req: Request) {
		return this.fetcher(req)
	}

	plugin() {
		return createElysiaApp(this.ctx, {
			aot: true,
			name: 'pluxel.http.internal.graphql',
		}).all(
			RUNTIME_TRANSPORT_PATHS.graphql,
			({ pluginCtx, request }) => pluginCtx.internalGraphql.fetch(request),
			{ parse: 'none' },
		)
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

	private rebuildNow() {
		this.rebuildDirty = false
		this.schema = createInternalGraphQLSchema(this.ctx)
		this.pushFetch()
		// NOTE: SOURCE_ONLY preprocessor blocks are stripped by tsdown for non-source builds.
		// Do NOT remove them or rewrite this into runtime conditions.
		// #if SOURCE_ONLY
		if (this.config?.codegen === true && process.env.NODE_ENV !== 'production') {
			void this.codegenNow()
		}
		// #endif
	}

	private pushFetch() {
		const yoga = createYoga({
			landingPage: false,
			graphqlEndpoint: RUNTIME_TRANSPORT_PATHS.graphql,
			maskedErrors: process.env.NODE_ENV === 'production',
			graphiql: process.env.NODE_ENV !== 'production',
			schema: this.schema,
			fetchAPI: {
				Response: globalThis.Response,
				Request: globalThis.Request,
				Headers: globalThis.Headers,
			},
		})

		this.fetcher = async (req: Request) => yoga.fetch(req)
	}

	// #if SOURCE_ONLY
	private async codegenNow() {
		if (this.config?.codegen !== true) return
		if (process.env.NODE_ENV === 'production') return
		if (this.codegenRunning) return
		this.codegenRunning = true
		const destination = new URL('../../../../components/src/app/gqlens/', import.meta.url)
		try {
			this.logger.info('Generating GQLens client…', { destination })

			const { fileURLToPath } = await import('node:url')
			const { generateGQLensFiles } = await import('@gqlens/vite')
			const stats = await generateGQLensFiles({
				schema: printSchema(this.schema),
				framework: 'react',
				output: fileURLToPath(destination),
			})

			this.logger.info('GQLens client generated', {
				destination,
				files: stats.total,
				changed: stats.changed,
			})
		} catch (error) {
			this.logger.error('generate GQLens client failed', { error, destination })
		} finally {
			this.codegenRunning = false
		}
	}
	// #endif
}
