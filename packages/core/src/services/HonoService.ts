import { type Context, Injectable } from '@pluxel/context'

const serviceName = 'honoService' as const

// 交给上游类型增强的去 declare
/* declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: HonoService
		}
	}
} */

export type AppMod<App = unknown> = (app: App) => void
export type HonoFetch = (
	req: Request,
	env?: unknown,
	ctx?: unknown,
) => Response | Promise<Response>
export type GraphQLFetch = (req: Request, ctx: unknown) => Response | Promise<Response>

@Injectable({ key: serviceName })
export class HonoService {
	protected fetchPtr: HonoFetch = async () =>
		new Response('Hono runtime unavailable', { status: 503 })
	protected gqlFetch: GraphQLFetch = async () =>
		new Response('GraphQL not ready', { status: 503 })

	constructor(public ctx: Context) {}

	get fetch() {
		return this.fetchPtr
	}

	createFactory(): unknown {
		throw new Error('Hono runtime not configured')
	}

	get viteHonoDevServer(): any {
		return undefined
	}

	/**
	 * Register an app modifier (routes/middlewares).
	 *
	 * Core does not ship a real Hono runtime; environments that support HTTP should override this
	 * service and implement `modifyApp()` (and typically `fetch`).
	 */
	modifyApp<App = unknown>(_mod: AppMod<App>): () => void {
		throw new Error('Hono runtime not configured')
	}

	/** Optional hook for implementations that keep a mods registry. */
	applyMods<App = unknown>(_app: App) {
		// no-op in core
	}

	setGraphQLFetch(fn: GraphQLFetch) {
		this.gqlFetch = fn
	}

	getGraphQLFetch() {
		return this.gqlFetch
	}

	switchAuthGuard(_toggle: boolean) {}
}
