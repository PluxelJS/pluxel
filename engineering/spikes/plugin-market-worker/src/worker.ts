import { newHttpBatchRpcResponse, RpcTarget } from 'capnweb'
import { eq } from 'drizzle-orm'
import semver from 'semver'
import validatePackageName from 'validate-npm-package-name'
import { notifications, registrations } from './schema'
import { connect, editRegistration, enqueue, type Coordinate } from './store'

type Env = { DB: D1Database; ADMIN_TOKEN: string }
type EditInput = { id: string; expectedRevision: number; label: string }

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function coordinate(value: unknown): value is Coordinate {
	return (
		object(value) &&
		value.registry === 'https://registry.npmjs.org' &&
		typeof value.packageName === 'string' &&
		validatePackageName(value.packageName).validForNewPackages &&
		typeof value.version === 'string' &&
		semver.valid(value.version) === value.version &&
		Object.keys(value).length === 3
	)
}

export class MarketAdmin extends RpcTarget {
	#db: ReturnType<typeof connect>
	constructor(binding: D1Database) {
		super()
		this.#db = connect(binding)
	}

	async getRecord(id: string) {
		if (typeof id !== 'string' || id.length > 200) throw new TypeError('Invalid record id')
		return (
			(await this.#db.select().from(registrations).where(eq(registrations.id, id)).get()) ?? null
		)
	}

	async editRecord(input: EditInput) {
		if (
			!object(input) ||
			typeof input.id !== 'string' ||
			!input.id ||
			input.id.length > 200 ||
			!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 1 ||
			typeof input.label !== 'string' ||
			!input.label ||
			input.label.length > 200 ||
			Object.keys(input).length !== 3
		) {
			return { status: 'invalid' as const }
		}
		return editRegistration(this.#db, input, 'spike-admin')
	}
}

function problem(status: number, title: string) {
	return Response.json(
		{ type: 'about:blank', title, status },
		{
			status,
			headers: { 'Content-Type': 'application/problem+json' },
		},
	)
}

function receipt(row: typeof notifications.$inferSelect) {
	return {
		id: row.id,
		registry: row.registry,
		packageName: row.packageName,
		version: row.version,
		status: row.status,
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname
		if (path === '/admin') {
			if (request.method !== 'POST') return problem(405, 'POST required')
			if (
				!env.ADMIN_TOKEN ||
				request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`
			) {
				return problem(401, 'Authentication required')
			}
			return newHttpBatchRpcResponse(request, new MarketAdmin(env.DB))
		}
		if (path === '/notifications' && request.method === 'POST') {
			let input: unknown
			try {
				input = await request.json()
			} catch {
				return problem(400, 'Invalid JSON')
			}
			if (!coordinate(input))
				return problem(400, 'Expected an allowed registry, package name and exact version')
			const row = await enqueue(connect(env.DB), input)
			return Response.json(receipt(row), {
				status: row.status === 'failed' ? 200 : 202,
				headers: { Location: `/notifications/${row.id}`, 'Cache-Control': 'no-store' },
			})
		}
		const match = /^\/notifications\/([\w-]+)$/.exec(path)
		if (match && request.method === 'GET') {
			const row = await connect(env.DB)
				.select()
				.from(notifications)
				.where(eq(notifications.id, match[1]))
				.get()
			return row
				? Response.json(receipt(row), { headers: { 'Cache-Control': 'no-store' } })
				: problem(404, 'Receipt not found')
		}
		return problem(404, 'Not found')
	},
} satisfies ExportedHandler<Env>
