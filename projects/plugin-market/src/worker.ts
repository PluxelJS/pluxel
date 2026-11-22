import { newHttpBatchRpcResponse } from 'capnweb'
import { eq } from 'drizzle-orm'
import { MarketAdmin } from './admin'
import { readCatalog } from './catalog-http'
import { authorizeGitHubNotification } from './github-notification'
import { json, marketResponse } from './http'
import { processNotifications } from './jobs'
import { coordinate, MarketError, readBytes, readJson } from './protocol'
import { notifications } from './schema'
import { exportCatalogSnapshot, snapshotByteLimit } from './snapshot'
import { connect, enqueue, receipt } from './store'
import { registrySources, sourceFor } from './sources'

export type Env = { DB: D1Database; ADMIN_TOKEN: string; REGISTRIES?: string }

async function dispatch(request: Request, env: Env): Promise<Response> {
	const { pathname: path } = new URL(request.url)
	const sources = registrySources(env.REGISTRIES)
	const authorization = request.headers.get('Authorization')
	const admin = Boolean(env.ADMIN_TOKEN) && authorization === `Bearer ${env.ADMIN_TOKEN}`
	if (path === '/admin') {
		if (request.method !== 'POST') throw new MarketError('method-not-allowed', 'POST required', 405)
		if (!admin) {
			throw new MarketError('unauthorized', 'Administration requires a bearer token', 401)
		}
		const bytes = await readBytes(request.body, 64 * 1024)
		const bounded = new Request(request.url, {
			method: 'POST',
			headers: request.headers,
			body: bytes,
		})
		const response = await newHttpBatchRpcResponse(bounded, new MarketAdmin(env.DB, sources))
		response.headers.set('Cache-Control', 'no-store')
		return response
	}
	const db = connect(env.DB)
	if (path === '/v1/snapshot' && request.method === 'GET') {
		const registries = sources
			.filter((source) => source.access === 'public')
			.map((source) => source.registry)
		return json(request, await exportCatalogSnapshot(db, registries), { snapshotByteLimit })
	}
	if (path === '/v1/notifications' && request.method === 'POST') {
		if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json')
			throw new MarketError('unsupported-media-type', 'Content-Type must be application/json', 415)
		const input = coordinate(await readJson(request.body, 4096))
		const source = sourceFor(sources, input.registry)
		if (
			source.access === 'admin' &&
			!admin &&
			(!source.notificationToken || authorization !== `Bearer ${source.notificationToken}`)
		)
			throw new MarketError(
				'unauthorized',
				'Private-source notifications require a notification credential',
				401,
			)
		const publishers = source.githubPublishers?.filter((rule) => rule.name === input.name) ?? []
		if (source.access === 'public' && !admin && authorization && publishers.length === 0)
			throw new MarketError(
				'github-oidc-publisher-denied',
				'No GitHub publisher is configured for this package',
				403,
			)
		const githubPublisher =
			!admin && publishers.length > 0
				? await authorizeGitHubNotification(request, publishers)
				: null
		const row = await enqueue(db, input, Date.now(), githubPublisher)
		return Response.json(receipt(row), {
			status: row.status === 'failed' || row.status === 'indexed' ? 200 : 202,
			headers: { Location: `/v1/notifications/${row.id}`, 'Cache-Control': 'no-store' },
		})
	}
	const taskMatch = /^\/v1\/notifications\/([\w-]{1,64})$/.exec(path)
	if (taskMatch && request.method === 'GET') {
		const row = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, taskMatch[1]))
			.get()
		const source = row ? sources.find((item) => item.registry === row.registry) : undefined
		if (
			!row ||
			!source ||
			(source.access === 'admin' &&
				!admin &&
				(!source.notificationToken || authorization !== `Bearer ${source.notificationToken}`))
		)
			throw new MarketError('not-found', 'Receipt not found or expired', 404)
		return Response.json(receipt(row), { headers: { 'Cache-Control': 'no-store' } })
	}
	const visibleSources = sources.filter((source) => admin || source.access === 'public')
	return readCatalog(request, db, visibleSources, { authenticated: admin, notifications: true })
}

export default {
	fetch(request: Request, env: Env) {
		return marketResponse(request, () => dispatch(request, env))
	},
	async scheduled(_controller: ScheduledController, env: Env) {
		await processNotifications(connect(env.DB))
	},
} satisfies ExportedHandler<Env>
