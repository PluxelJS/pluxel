import { query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import { generateClient } from '@gqty/cli'
import { Injectable, type Context as PlxContext } from '@pluxel/core'
import type { GraphQLSchema } from 'graphql'
import { createYoga } from 'graphql-yoga'
import * as v from 'valibot'

import { getAPISchema } from '../../api'

const serviceName = 'internalGraphql' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: InternalGraphQLService
	}
}

type ServerCtx = {}

@Injectable({ key: serviceName })
export class InternalGraphQLService {
	private readonly logger: NonNullable<PlxContext['logger']>

	private schema: GraphQLSchema = this.weaveSchema()
	private fetcher: (req: Request, ctx: ServerCtx) => Promise<Response>

	private rebuildPending = false
	private rebuildDirty = false
	private codegenRunning = false

	constructor(private readonly ctx: PlxContext) {
		this.logger = ctx.logger!
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
		void this.codegenNow()
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

	private async codegenNow() {
		if (this.codegenRunning) return
		this.codegenRunning = true
		try {
			this.logger.info('[Internal-GQty] Generating client…')

			await generateClient(this.schema, {
				endpoint: 'http://localhost:3000/api/graphql',
				destination: '../components/src/app/gqty/index.ts',
				react: true,
			})

			this.logger.info('[Internal-GQty] Client generated ✔')
		} catch (e) {
			this.logger.error('[Internal-GQty] generateClient failed', e)
		} finally {
			this.codegenRunning = false
		}
	}
}
