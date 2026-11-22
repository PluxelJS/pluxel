import { BasePlugin, Plugin } from '@pluxel/core'
import { newHttpBatchRpcResponse } from 'capnweb'
import { MarketAdmin } from './admin'
import type { MarketResources } from './bindings'
import { MarketDeployment } from './deployment'
import { readCatalog } from './catalog/http'
import { exportCatalogSnapshot, snapshotByteLimit } from './catalog/snapshot'
import { json, marketResponse } from './http'
import { notificationResponse } from './indexing/http'
import { processNotifications } from './indexing/jobs'
import { MarketError, readBytes } from './protocol'
import { isHostedRegistryPath } from './registry/route'

@Plugin()
export class MarketPlugin extends BasePlugin {
	private deployment!: MarketDeployment

	protected override init() {
		this.deployment = this.ctx.service(MarketDeployment)
	}

	async fetch(request: Request, bindings: MarketResources): Promise<Response> {
		const { pathname } = new URL(request.url)
		const { db, sources, fetchHosted } = this.deployment.open(bindings)
		if (isHostedRegistryPath(pathname))
			return fetchHosted?.(request) ?? new Response(null, { status: 404 })
		return marketResponse(request, async () => {
			const admin =
				Boolean(bindings.ADMIN_TOKEN) &&
				request.headers.get('Authorization') === `Bearer ${bindings.ADMIN_TOKEN}`
			if (pathname === '/admin') {
				if (request.method !== 'POST')
					throw new MarketError('method-not-allowed', 'POST required', 405)
				if (!admin)
					throw new MarketError('unauthorized', 'Administration requires a bearer token', 401)
				const bounded = new Request(request.url, {
					method: 'POST',
					headers: request.headers,
					body: await readBytes(request.body, 64 * 1024),
					signal: request.signal,
				})
				const response = await newHttpBatchRpcResponse(
					bounded,
					new MarketAdmin({
						db,
						sources,
						review: this.deployment.review,
						signal: request.signal,
					}),
				)
				response.headers.set('Cache-Control', 'no-store')
				return response
			}
			if (pathname === '/v1/snapshot' && request.method === 'GET') {
				const registries = sources
					.filter((source) => source.access === 'public')
					.map((source) => source.registry)
				return json(request, await exportCatalogSnapshot(db, registries), { snapshotByteLimit })
			}
			const notification = notificationResponse(request, pathname, {
				db,
				sources,
				admin,
			})
			if (notification) return notification
			const visibleSources = sources.filter((source) => admin || source.access === 'public')
			return readCatalog(request, db, visibleSources, {
				authenticated: admin,
				notifications: true,
			})
		})
	}

	processNotifications(bindings: MarketResources) {
		const { db, sources } = this.deployment.open(bindings)
		return processNotifications(db, sources, { review: this.deployment.review })
	}
}
