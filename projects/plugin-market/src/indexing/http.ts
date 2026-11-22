import type { Database } from '../db/d1'
import { coordinate, MarketError, readJson } from '../protocol'
import { authorizeGitHubPublisher } from '../registry/github-publisher'
import { sourceFor, type RegistrySource } from '../registry/sources'
import { enqueue, findNotification, receipt } from './notifications'

type NotificationAccess = {
	db: Database
	sources: readonly RegistrySource[]
	admin: boolean
}

export function notificationResponse(request: Request, path: string, access: NotificationAccess) {
	if (path === '/v1/notifications' && request.method === 'POST')
		return submitNotification(request, access)
	const match = /^\/v1\/notifications\/([\w-]{1,64})$/.exec(path)
	if (match && request.method === 'GET') return readNotification(request, match[1], access)
	return undefined
}

function hasNotificationToken(source: RegistrySource, authorization: string | null) {
	return Boolean(source.notificationToken) && authorization === `Bearer ${source.notificationToken}`
}

async function submitNotification(request: Request, { db, sources, admin }: NotificationAccess) {
	const authorization = request.headers.get('Authorization')
	const notificationAudience = new URL('/v1/notifications', request.url).href
	if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json')
		throw new MarketError('unsupported-media-type', 'Content-Type must be application/json', 415)
	const input = coordinate(await readJson(request.body, 4096))
	const source = sourceFor(sources, input.registry)
	const publishers = source.githubPublishers?.filter((rule) => rule.name === input.name) ?? []
	const sourceCredential = source.access === 'admin' && hasNotificationToken(source, authorization)
	if (source.access === 'admin' && !admin && !sourceCredential && publishers.length === 0)
		throw new MarketError(
			'unauthorized',
			'Private-source notifications require a notification credential',
			401,
		)
	if (source.access === 'public' && !admin && authorization && publishers.length === 0)
		throw new MarketError(
			'github-oidc-publisher-denied',
			'No GitHub publisher is configured for this package',
			403,
		)
	const githubPublisher =
		!admin && !sourceCredential && publishers.length > 0
			? await authorizeGitHubPublisher(request, publishers, notificationAudience)
			: null
	const row = await enqueue(db, input, Date.now(), githubPublisher)
	return Response.json(receipt(row), {
		status: row.status === 'failed' || row.status === 'indexed' ? 200 : 202,
		headers: { Location: `/v1/notifications/${row.id}`, 'Cache-Control': 'no-store' },
	})
}

async function readNotification(
	request: Request,
	id: string,
	{ db, sources, admin }: NotificationAccess,
) {
	const authorization = request.headers.get('Authorization')
	const notificationAudience = new URL('/v1/notifications', request.url).href
	const row = await findNotification(db, id)
	const source = row ? sources.find((item) => item.registry === row.registry) : undefined
	const notFound = () => new MarketError('not-found', 'Receipt not found or expired', 404)
	if (!row || !source) throw notFound()
	if (source.access === 'admin' && !admin && !hasNotificationToken(source, authorization)) {
		const publishers = source.githubPublishers?.filter((rule) => rule.name === row.name) ?? []
		if (!authorization || publishers.length === 0) throw notFound()
		try {
			await authorizeGitHubPublisher(request, publishers, notificationAudience)
		} catch (error) {
			if (error instanceof MarketError) throw notFound()
			throw error
		}
	}
	return Response.json(receipt(row), { headers: { 'Cache-Control': 'no-store' } })
}
