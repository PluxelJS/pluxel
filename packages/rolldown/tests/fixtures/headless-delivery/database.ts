import { appendFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import type { Context } from '@pluxel/core'

interface ApplicationDatabase {
	readonly client: Client
	record(event: string): void
}

const databases = new WeakMap<object, ApplicationDatabase>()

/** The application owns one native connection per root, before any Plugin starts. */
export async function prepareDatabase(ctx: Context, directory: string): Promise<void> {
	const root = ctx.root
	await mkdir(directory, { recursive: true })
	const client = createClient({ url: pathToFileURL(join(directory, 'documents.db')).href })
	const record = (event: string) => {
		appendFileSync(join(directory, 'events.log'), event + '\n')
		console.log(`EVENT ${event}`)
	}
	root.effects.defer(
		() => {
			databases.delete(root)
			client.close()
			record('database.closed')
		},
		{ tag: 'ApplicationDatabase', phase: 'shutdown' },
	)
	await client.execute('CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, path TEXT)')
	await client.execute({
		sql: 'INSERT OR REPLACE INTO documents (name, path) VALUES (?, ?)',
		args: ['example.pdf', join(directory, 'example.pdf')],
	})
	databases.set(root, { client, record })
	record('database.prepared')
}

export function databaseFor(ctx: Context): ApplicationDatabase {
	const database = databases.get(ctx.root)
	if (!database) throw new Error('Application database has not been prepared')
	return database
}
