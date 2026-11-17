import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { BasePlugin, Plugin } from '@pluxel/core'
import { ElysiaApp } from '@pluxel/services/elysia'
import * as v from 'valibot'
import { databaseFor } from './database.js'

@Plugin()
export class QueryHttpPlugin extends BasePlugin {
	private readonly config = this.configs.use(v.object({ fail: v.optional(v.boolean(), false) }))

	protected override init() {
		const database = databaseFor(this.ctx)
		if (this.config.fail) throw new Error('Query capability failed to initialize')
		this.ctx.require(ElysiaApp).get('/query', async () => {
			const result = await database.client.execute('SELECT 6 * 7 AS answer')
			return result.rows[0]
		})
	}
}

@Plugin()
export class PdfHttpPlugin extends BasePlugin {
	protected override init() {
		const database = databaseFor(this.ctx)
		const pending = new Set<Promise<void>>()
		this.ctx.require(ElysiaApp).get('/documents/:name', async ({ params, request }) => {
			const result = await database.client.execute({
				sql: 'SELECT path FROM documents WHERE name = ?',
				args: [params.name],
			})
			const path = result.rows[0]?.path
			if (typeof path !== 'string')
				return new Response('document missing', {
					status: 404,
					headers: { 'content-type': 'text/plain', 'x-document': 'missing' },
				})
			const stream = createReadStream(path, { signal: request.signal })
			database.record('pdf.opened')
			const closed = new Promise<void>((resolve) => {
				stream.once('close', () => {
					pending.delete(closed)
					database.record(request.signal.aborted ? 'pdf.aborted' : 'pdf.completed')
					resolve()
				})
			})
			pending.add(closed)
			// Node and DOM declare the same native Web stream with different TypeScript interfaces.
			return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
				headers: { 'content-type': 'application/pdf' },
			})
		})
		// Web cancellation can settle before Node emits close. The file owner waits for its IO.
		return async () => {
			await Promise.all(pending)
		}
	}
}
