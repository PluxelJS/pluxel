import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { drizzle, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { readCatalog } from './catalog-http'
import { marketResponse } from './http'
import { MarketError, readJson } from './protocol'
import { decodeCatalogSnapshot, snapshotByteLimit, type CatalogSnapshot } from './snapshot'

const applicationId = 0x504c4d52 // PLMR
const sqliteTimeout = 5_000

function mirrorState(database: DatabaseSync) {
	const header = database
		.prepare(
			'SELECT application_id, user_version FROM pragma_application_id(), pragma_user_version()',
		)
		.get()!
	if (
		header.application_id === 0 &&
		header.user_version === 0 &&
		!database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()
	)
		return null
	if (
		header.application_id !== applicationId ||
		typeof header.user_version !== 'number' ||
		header.user_version < 1
	)
		throw new Error('Expected a dedicated market mirror database')
	const row = database
		.prepare('SELECT origin, etag, generation, registries FROM mirror_state')
		.get()
	if (
		!row ||
		typeof row.origin !== 'string' ||
		typeof row.etag !== 'string' ||
		typeof row.generation !== 'number' ||
		typeof row.registries !== 'string'
	)
		throw new Error('Invalid market mirror state')
	const registries: unknown = JSON.parse(row.registries)
	if (!Array.isArray(registries) || !registries.every((registry) => typeof registry === 'string'))
		throw new Error('Invalid market mirror registry list')
	return {
		origin: row.origin,
		etag: row.etag,
		generation: row.generation,
		registries,
		schemaVersion: header.user_version,
	}
}

function existingMirror(file: string) {
	if (!existsSync(file)) return null
	using database = new DatabaseSync(file, { readOnly: true, timeout: sqliteTimeout })
	database.exec('BEGIN')
	try {
		return mirrorState(database)
	} finally {
		database.exec('ROLLBACK')
	}
}

function replaceCatalog(database: DatabaseSync, snapshot: CatalogSnapshot) {
	database.exec('DELETE FROM releases; DELETE FROM packages; DELETE FROM market_authors;')
	const author = database.prepare(`
		INSERT INTO market_authors (id, name, kind, avatar_url, observed_at)
		VALUES ($id, $name, $kind, $avatarUrl, 0)
	`)
	const pkg = database.prepare(`
		INSERT INTO packages (
			registry, name, description, repository, repository_stars, repository_observed_at,
			repository_author_id, curated_author_id, metadata_version, readme, license,
			dist_tags, observed_at, official, category, tags
		) VALUES (
			$registry, $name, $description, $repository, $repositoryStars, $repositoryObservedAt,
			$repositoryAuthorId, $curatedAuthorId, $metadataVersion, $readme, $license,
			$distTags, $observedAt, $official, $category, $tags
		)
	`)
	const release = database.prepare(`
		INSERT INTO releases (
			registry, name, version, tarball, integrity, checked_at, provenance,
			peer_dependencies, plugin_packages, readme, license
		) VALUES (
			$registry, $name, $version, $tarball, $integrity, $checkedAt, $provenance,
			$peerDependencies, $pluginPackages, $readme, $license
		)
	`)
	for (const entry of snapshot.authors) author.run(entry)
	for (const { authorId, ...entry } of snapshot.packages) {
		pkg.run({
			...entry,
			repositoryAuthorId: authorId?.startsWith('github:') ? authorId : null,
			curatedAuthorId: authorId?.startsWith('market:') ? authorId : null,
			readme: entry.readme === null ? null : JSON.stringify(entry.readme),
			distTags: JSON.stringify(entry.distTags),
			official: Number(entry.official),
			tags: JSON.stringify(entry.tags),
		})
	}
	for (const entry of snapshot.releases) {
		release.run({
			...entry,
			provenance: JSON.stringify(entry.provenance),
			peerDependencies: JSON.stringify(entry.peerDependencies),
			pluginPackages: JSON.stringify(entry.pluginPackages),
			readme: entry.readme === null ? null : JSON.stringify(entry.readme),
		})
	}
}

async function sync(origin: string, file: string, migrations: readonly string[]) {
	const base = existingMirror(file)
	if (base && base.origin !== origin)
		throw new Error('This mirror belongs to a different origin. Choose a new database file.')
	if (base && base.schemaVersion > migrations.length)
		throw new Error('Use a current mirror bundle with this database')
	const etag = base?.schemaVersion === migrations.length ? base.etag : undefined
	const response = await fetch(`${origin}/v1/snapshot`, {
		headers: etag === undefined ? {} : { 'If-None-Match': etag },
		redirect: 'error',
		signal: AbortSignal.timeout(60_000),
	})
	if (response.status === 304 && etag !== undefined) {
		console.info('Market mirror unchanged')
		return
	}
	const receivedETag = response.headers.get('ETag')
	if (
		response.status !== 200 ||
		!receivedETag ||
		!/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(receivedETag)
	) {
		await response.body?.cancel()
		throw new Error(`Expected a market snapshot with an ETag (HTTP ${response.status})`)
	}
	const snapshot = decodeCatalogSnapshot(await readJson(response.body, snapshotByteLimit))
	using database = new DatabaseSync(file, { timeout: sqliteTimeout })
	if (!base && !existingMirror(file)) database.exec('PRAGMA journal_mode = WAL')
	database.exec('BEGIN IMMEDIATE')
	try {
		const current = mirrorState(database)
		if (
			current?.generation !== base?.generation ||
			current?.etag !== base?.etag ||
			current?.origin !== base?.origin
		)
			throw new Error('The mirror was updated during sync. Run sync again.')
		if (current === null) {
			database.exec(`
				PRAGMA application_id = ${applicationId};
				CREATE TABLE mirror_state (
					id INTEGER PRIMARY KEY CHECK (id = 1), origin TEXT NOT NULL, etag TEXT NOT NULL,
					generation INTEGER NOT NULL, registries TEXT NOT NULL
				) STRICT;
			`)
		}
		for (const migration of migrations.slice(current?.schemaVersion ?? 0)) database.exec(migration)
		database.exec(`PRAGMA user_version = ${migrations.length}`)
		replaceCatalog(database, snapshot)
		database
			.prepare(`
				INSERT INTO mirror_state (id, origin, etag, generation, registries) VALUES (1, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET etag = excluded.etag, generation = excluded.generation,
					registries = excluded.registries
			`)
			.run(
				origin,
				receivedETag,
				(current?.generation ?? 0) + 1,
				JSON.stringify(snapshot.registries),
			)
		database.exec('COMMIT')
	} catch (error) {
		if (database.isTransaction) database.exec('ROLLBACK')
		throw error
	}
	console.info(
		`Market mirror synced: ${snapshot.packages.length} packages, ${snapshot.releases.length} releases`,
	)
}

function connectReader(database: DatabaseSync) {
	function query(sql: string, params: SQLInputValue[], method: Parameters<AsyncRemoteCallback>[2]) {
		if (method === 'run') throw new Error('The market mirror database is read-only')
		const statement = database.prepare(sql)
		statement.setReturnArrays(true)
		// sqlite-proxy expects an unwrapped row (or undefined) for get.
		return {
			rows:
				method === 'get'
					? (statement.get(...params) as unknown as unknown[])
					: statement.all(...params),
		}
	}
	return drizzle(
		async (sql, params, method) => query(sql, params, method),
		async (queries) => queries.map(({ sql, params, method }) => query(sql, params, method)),
	)
}

async function serve(file: string, schemaVersion: number) {
	if (existingMirror(file)?.schemaVersion !== schemaVersion)
		throw new Error('Sync the database with this mirror bundle before serving')
	const port = Number(process.env.PORT ?? 8787)
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid mirror PORT')
	const host = process.env.HOST ?? '127.0.0.1'
	if (host.length === 0) throw new Error('Invalid mirror HOST')

	async function respond(incoming: IncomingMessage, outgoing: ServerResponse) {
		const { method, url } = incoming
		if (method !== 'GET' && method !== 'OPTIONS') {
			outgoing.writeHead(405, { Allow: 'GET, OPTIONS', 'Cache-Control': 'no-store' }).end()
			return
		}
		if (!url?.startsWith('/')) {
			outgoing.writeHead(400, { 'Cache-Control': 'no-store' }).end()
			return
		}
		const headers = new Headers()
		for (let index = 0; index < incoming.rawHeaders.length; index += 2)
			headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
		const request = new Request(`http://mirror${url}`, { method, headers })
		const result = await marketResponse(
			request,
			async () => {
				using database = new DatabaseSync(file, { readOnly: true, timeout: sqliteTimeout })
				database.exec('BEGIN')
				try {
					const state = mirrorState(database)
					if (state?.schemaVersion !== schemaVersion)
						throw new MarketError(
							'mirror-unavailable',
							'Sync and run the current mirror bundle',
							503,
						)
					return await readCatalog(
						request,
						connectReader(database),
						state.registries.map((registry) => ({ registry, access: 'public' })),
					)
				} finally {
					if (database.isTransaction) database.exec('ROLLBACK')
				}
			},
			'GET, OPTIONS',
		)
		const body = result.body === null ? undefined : await result.bytes()
		outgoing.writeHead(result.status, Object.fromEntries(result.headers)).end(body)
	}
	const server = createServer((incoming, outgoing) => {
		void respond(incoming, outgoing).catch((error: unknown) => {
			console.error(error)
			if (outgoing.headersSent) outgoing.destroy()
			else
				outgoing.writeHead(500, { 'Cache-Control': 'no-store' }).end('Market mirror request failed')
		})
	})
	server.listen(port, host)
	await once(server, 'listening')
	const address = server.address()
	if (address === null || typeof address === 'string')
		throw new Error('Expected an HTTP listener address')
	const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address
	console.info(`Market mirror ready: http://${hostname}:${address.port}`)
	const stop = () => server.close()
	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	try {
		await once(server, 'close')
	} finally {
		process.off('SIGINT', stop)
		process.off('SIGTERM', stop)
	}
}

export async function main(migrations: readonly string[]) {
	const [command, first, second, ...rest] = process.argv.slice(2)
	if (command === 'serve' && first && second === undefined) {
		await serve(resolve(first), migrations.length)
		return
	}
	if (command === 'sync' && first && second && rest.length === 0) {
		const url = new URL(first)
		const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
		if (
			(url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error('Use an HTTPS origin or loopback HTTP without credentials, query or fragment')
		await sync(url.href.replace(/\/$/, ''), resolve(second), migrations)
		return
	}
	throw new Error('Usage: node mirror.mjs sync <origin> <database> | serve <database>')
}
