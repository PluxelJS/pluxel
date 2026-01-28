import { query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import { Injectable, type Context as PlxContext } from '@pluxel/core'
import type { GraphQLSchema } from 'graphql'
import { createYoga } from 'graphql-yoga'
import * as v from 'valibot'

import { getAPISchema } from '../../api'

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

type ServerCtx = Record<string, never>

export type InternalGraphQLConfig = {
	/**
	 * Generate GQty client into the workspace (high churn, writes files).
	 *
	 * NOTE: Only effective in SOURCE_ONLY builds.
	 */
	codegen?: boolean
}

@Injectable({ key: serviceName })
export class InternalGraphQLService {
	private readonly logger: NonNullable<PlxContext['logger']>
	private readonly config: InternalGraphQLConfig | undefined

	private schema: GraphQLSchema = this.weaveSchema()
	private fetcher: (req: Request, ctx: ServerCtx) => Promise<Response>

	private rebuildPending = false
	private rebuildDirty = false
	private codegenRunning = false

	constructor(
		public ctx: PlxContext,
		cfg?: InternalGraphQLConfig,
	) {
		this.logger = ctx.logger!
		this.config = cfg
		this.fetcher = async () => new Response('Internal GraphQL not ready', { status: 503 })
		this.scheduleRebuild()
	}

	get fetch() {
		return this.fetcher
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
		this.schema = this.weaveSchema()
		this.pushFetch()
		// NOTE: SOURCE_ONLY preprocessor blocks are stripped by tsdown for non-source builds.
		// Do NOT remove them or rewrite this into runtime conditions.
		//#if SOURCE_ONLY
		// Codegen is intentionally opt-in: it writes files into the workspace and is high-churn.
		if (this.config?.codegen === true && process.env.NODE_ENV !== 'production') {
			void this.codegenNow()
		}
		//#endif
	}

	private weaveSchema(): GraphQLSchema {
		const resolvers: Resolver[] = [
			resolver({
				_empty: query(v.string()).resolve(() => 'ok'),
			}),
		]
		return weave(ValibotWeaver, ...resolvers, ...getAPISchema(this.ctx))
	}

	private pushFetch() {
		const yoga = createYoga<ServerCtx>({
			landingPage: false,
			graphqlEndpoint: '/api/graphql',
			maskedErrors: process.env.NODE_ENV === 'production',
			graphiql: process.env.NODE_ENV !== 'production',
			schema: this.schema,
			fetchAPI: {
				Response: globalThis.Response,
				Request: globalThis.Request,
				Headers: globalThis.Headers,
			},
		})

		this.fetcher = async (req: Request, ctx: ServerCtx) => yoga.fetch(req, ctx)
	}

	//#if SOURCE_ONLY
	private async codegenNow() {
		if (this.config?.codegen !== true) return
		if (process.env.NODE_ENV === 'production') return
		if (this.codegenRunning) return
		this.codegenRunning = true
		const destination = '../components/src/app/gqty/index.ts'
		try {
			this.logger.info('Generating GQty client…', { destination })

			const { generateClient } = await import('@gqty/cli')
			await generateClient(this.schema, {
				endpoint: 'http://localhost:3000/api/graphql',
				destination,
				react: true,
			})

			this.logger.info('GQty client generated', { destination })
		} catch (error) {
			this.logger.error('generateClient failed', { error, destination })
		} finally {
			this.codegenRunning = false
		}
	}
	//#endif
}
