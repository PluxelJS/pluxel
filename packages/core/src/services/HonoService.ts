import { type Context, Injectable } from '@pluxel/context'

const serviceName = 'honoService' as const

declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: HonoService
		}
	}
}

export type AppMod<App = unknown> = (app: App) => void
export type HonoFetch = (
	req: Request,
	env?: unknown,
	ctx?: unknown,
) => Response | Promise<Response>
export type GraphQLFetch = (req: Request, ctx: unknown) => Response | Promise<Response>

@Injectable({ key: serviceName })
export class HonoService {
	protected readonly mods = new Set<AppMod<any>>()
	protected pendingRebuild = false
	protected fetchPtr: HonoFetch = async () =>
		new Response('Hono runtime unavailable', { status: 503 })
	protected gqlFetch: GraphQLFetch = async () =>
		new Response('GraphQL not ready', { status: 503 })

	constructor(public ctx: Context) {}

	get fetch() {
		return this.fetchPtr
	}

	createFactory(): unknown {
		throw new Error('Hono factory not configured')
	}

	get viteHonoDevServer(): any {
		return undefined
	}

	modifyApp<App = unknown>(mod: AppMod<App>) {
		const m = mod as AppMod<any>
		this.mods.add(m)
		this.scheduleRebuild()

		const dispose = () => {
			if (this.mods.delete(m)) this.scheduleRebuild()
		}
		const collect = (this.ctx as Context & { collectEffect?: (fn: () => void) => () => void })
			.collectEffect
		return collect ? collect.call(this.ctx, dispose) : dispose
	}

	applyMods<App = unknown>(app: App) {
		for (const mod of this.mods) (mod as AppMod<App>)(app)
	}

	setGraphQLFetch(fn: GraphQLFetch) {
		this.gqlFetch = fn
		this.scheduleRebuild()
	}

	getGraphQLFetch() {
		return this.gqlFetch
	}

	switchAuthGuard(_toggle: boolean) {}

	protected scheduleRebuild() {
		if (this.pendingRebuild) return
		this.pendingRebuild = true
		queueMicrotask(() => {
			this.pendingRebuild = false
			this.rebuildNow()
		})
	}

	protected rebuildNow(): void {}
}
