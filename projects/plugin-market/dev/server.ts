import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { marketAssets } from './assets.ts'
import { localRoot, projectRoot, sessionPath, type Session } from './session.ts'

const registryUrl = new URL(process.env.MARKET_TEST_REGISTRY ?? 'http://127.0.0.1:7677/npm/')
if (
	registryUrl.protocol !== 'http:' ||
	registryUrl.hostname !== '127.0.0.1' ||
	registryUrl.pathname !== '/npm/' ||
	registryUrl.username ||
	registryUrl.password ||
	registryUrl.search ||
	registryUrl.hash
) {
	throw new Error('MARKET_TEST_REGISTRY must be a loopback PNPR /npm/ URL')
}

await mkdir(localRoot, { recursive: true, mode: 0o700 })
async function secret(file: string) {
	const path = resolve(localRoot, file)
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		const token = crypto.randomUUID()
		await writeFile(path, token, { mode: 0o600, flag: 'wx' })
		return token
	}
}
const adminToken = await secret('admin-token')
const notificationToken = await secret('notification-token')
const credentialsPath = resolve(localRoot, 'registry-user.json')
let credentials: { name: string; password: string }
try {
	credentials = JSON.parse(await readFile(credentialsPath, 'utf8')) as typeof credentials
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	credentials = { name: `demo-${crypto.randomUUID().slice(0, 8)}`, password: crypto.randomUUID() }
	await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' })
}
const loginResponse = await fetch(
	new URL(`/-/user/org.couchdb.user:${credentials.name}`, registryUrl),
	{
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...credentials, email: `${credentials.name}@example.invalid` }),
		signal: AbortSignal.timeout(30_000),
	},
)
if (!loginResponse.ok) throw new Error(`PNPR login failed: HTTP ${loginResponse.status}`)
const login = (await loginResponse.json()) as { token?: string }
if (!login.token) throw new Error('PNPR login did not return a token')
const registry = registryUrl.href.replace(/\/$/, '')
const output = await build({
	entryPoints: [resolve(projectRoot, 'src/worker.ts')],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'browser',
})
const runtime = new Miniflare({
	host: '127.0.0.1',
	port: Number(process.env.PORT ?? 8787),
	resourcePersistencePath: resolve(localRoot, 'worker'),
	workers: [
		{
			config: {
				name: 'plugin-market-sandbox',
				compatibilityDate: '2026-11-03',
				assets: marketAssets,
				manifest: {
					mainModule: 'worker.mjs',
					modules: { 'worker.mjs': { type: 'esm', contents: output.outputFiles[0].text } },
				},
				env: {
					DB: { type: 'd1', id: 'plugin-market-sandbox' },
					ADMIN_TOKEN: { type: 'text', value: adminToken },
					REGISTRIES: {
						type: 'text',
						value: JSON.stringify([
							{ registry: 'https://registry.npmjs.org', access: 'public' },
							{ registry, access: 'admin', token: login.token, notificationToken },
						]),
					},
				},
			},
		},
	],
})

try {
	const address = await runtime.ready
	const db = await runtime.getD1Database('DB')
	const initialized = await db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'packages'")
		.first()
	// Only a virgin test fixture is provisioned here. Existing data is migrated
	// explicitly by its operator; deployment migrations remain owned by Wrangler.
	if (!initialized) {
		const directory = resolve(projectRoot, 'migrations')
		const files = await readdir(directory)
		const migrations = files.filter((file) => file.endsWith('.sql')).sort()
		for (const file of migrations) {
			const sql = await readFile(resolve(directory, file), 'utf8')
			const statements = sql
				.split('--> statement-breakpoint')
				.map((value) => value.trim())
				.filter(Boolean)
			await db.batch(statements.map((statement) => db.prepare(statement)))
		}
	}
	const columns = await db.prepare('PRAGMA table_info(packages)').all<{ name: string }>()
	const releaseColumns = await db.prepare('PRAGMA table_info(releases)').all<{ name: string }>()
	const search = await db
		.prepare("SELECT name FROM sqlite_master WHERE name = 'package_search'")
		.first()
	if (
		![
			'registry',
			'official',
			'category',
			'tags',
			'repository',
			'repository_stars',
			'repository_observed_at',
		].every((name) => columns.results.some((column) => column.name === name)) ||
		!['readme', 'license'].every((name) =>
			releaseColumns.results.some((column) => column.name === name),
		) ||
		!search
	)
		throw new Error(
			'Existing sandbox D1 needs the current migrations applied explicitly before starting market',
		)
	const session: Session = {
		marketUrl: address.origin,
		publicUrl: process.env.PITCHFORK_URL ?? address.origin,
		registryUrl: registryUrl.href,
		registry,
		registryToken: login.token,
		notificationToken,
		adminToken,
	}
	await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
	console.info(`Market sandbox ready: ${session.publicUrl}/v1`)
	console.info(`Private PNPR source: ${registry}; public npm remains a separate source.`)
	console.info(
		'Automatic provenance verification remains unavailable. Use sandbox:admin for manual indexing.',
	)
	await new Promise<void>((accept) => {
		process.once('SIGINT', accept)
		process.once('SIGTERM', accept)
	})
} finally {
	await runtime.dispose()
}
