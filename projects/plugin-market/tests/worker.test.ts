import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { URL } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { newHttpBatchRpcSession } from 'capnweb'
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import {
	Miniflare,
	Response as MiniflareResponse,
	type Request as MiniflareRequest,
} from 'miniflare'
import { packTar, type TarEntry } from 'modern-tar'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMarketWorker, workerModule } from '../dev/build-worker'
import { fetchObservation, fetchRelease } from '../src/registry/npm'
import { registrySources } from '../src/registry/sources'
import type { MarketAdmin } from '../src/admin'
import { connect } from '../src/db/d1'
import { catalogSnapshotResponse } from '../src/catalog/snapshot'
import {
	MarketError,
	registry,
	type CatalogFacets,
	type PackagePage,
	type Receipt,
} from '../src/protocol'
import {
	audits,
	hostedReleases,
	hostedTags,
	notifications,
	packages,
	releases,
} from '../src/db/schema'
import { commitRelease } from '../src/indexing/commit'
import {
	claim,
	enqueue,
	failAttempt,
	maxAttempts,
	pendingNotifications,
} from '../src/indexing/notifications'

type Fixture = {
	registry: string
	name: string
	version: string
	bytes: Uint8Array
	integrity: string
	metadata: Record<string, unknown>
	tags: Record<string, string>
}

describe('plugin market on workerd and D1', () => {
	let runtime: Miniflare
	let db: ReturnType<typeof connect>
	let origin: URL
	let directory: string
	let script: string
	const token = crypto.randomUUID()
	const privateRegistry = 'https://private.example/npm'
	const githubIssuer = 'https://token.actions.githubusercontent.com'
	const githubPublisherRule = {
		name: '@example/ci-plugin',
		repositoryId: '123',
		repositoryOwnerId: '456',
		workflowRef: 'publisher/plugin/.github/workflows/publish.yml@refs/heads/main',
		jobWorkflowRef: `pluxeljs/pluxel/.github/workflows/plugin-publish.yml@${'a'.repeat(40)}`,
	}
	let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
	let signingJwk: Awaited<ReturnType<typeof exportJWK>>
	let githubKeysAvailable = true
	const sources = [
		{ registry, access: 'public', githubPublishers: [githubPublisherRule] },
		{
			registry: privateRegistry,
			access: 'admin',
			token: 'read-private',
			notificationToken: 'notify-private',
			notificationIndexing: 'unsigned',
		},
	]
	const fixtures = new Map<string, Fixture>()
	const requests: string[] = []
	function githubRepository() {
		return {
			status: 200,
			body: {
				full_name: 'unverified/claim',
				stargazers_count: 42,
				owner: {
					id: 128,
					login: 'unverified',
					avatar_url: 'https://avatars.githubusercontent.com/u/128?v=4',
				},
			},
		}
	}
	let github = githubRepository()
	const selected = { registry, name: '@example/plugin', version: '1.0.0' }

	async function fixture(
		name = selected.name,
		options: {
			registry?: string
			version?: string
			manifest?: Record<string, unknown>
			extra?: TarEntry[]
		} = {},
	) {
		const source = options.registry ?? registry
		const version = options.version ?? selected.version
		const body = JSON.stringify({
			name,
			version,
			description: `Package ${name}`,
			exports: { '.': './dist/index.mjs' },
			peerDependencies: { '@pluxel/core': '^1.0.0' },
			repository: 'https://github.com/unverified/claim',
			...options.manifest,
		})
		const bytes = gzipSync(
			await packTar([
				{
					header: {
						name: 'package/package.json',
						size: new TextEncoder().encode(body).byteLength,
						type: 'file',
					},
					body,
				},
				{
					header: { name: 'package/dist/index.mjs', size: 25, type: 'file' },
					body: 'throw new Error("run!");\n',
				},
				...(options.extra ?? []),
			]),
		)
		const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
		const result: Fixture = {
			registry: source,
			name,
			version,
			bytes,
			integrity,
			tags: { latest: version },
			metadata: {
				name,
				version,
				description: 'Untrusted metadata description',
				dist: {
					tarball: `${source}/${encodeURIComponent(name)}/-/${version}.tgz`,
					integrity,
				},
			},
		}
		fixtures.set(`${source}:${name}@${version}`, result)
		return result
	}

	function registryReply(request: MiniflareRequest) {
		const url = new URL(request.url)
		if (url.href === `${githubIssuer}/.well-known/jwks`) {
			expect(request.headers.has('Authorization')).toBe(false)
			if (!githubKeysAvailable) return new MiniflareResponse(null, { status: 503 })
			return MiniflareResponse.json({ keys: [signingJwk] })
		}
		if (url.origin === 'https://api.github.com')
			return MiniflareResponse.json(github.body, { status: github.status })
		if (!sources.some((source) => request.url.startsWith(`${source.registry}/`)))
			throw new Error(`Unexpected source ${url.origin}`)
		if (request.url.startsWith(`${privateRegistry}/`))
			expect(request.headers.get('Authorization')).toBe('Bearer read-private')
		for (const item of fixtures.values()) {
			if (request.url === `${item.registry}/${encodeURIComponent(item.name)}`)
				return MiniflareResponse.json({
					name: item.name,
					'dist-tags': item.tags,
					versions: Object.fromEntries(
						[...fixtures.values()]
							.filter((other) => other.registry === item.registry && other.name === item.name)
							.map((other) => [other.version, other.metadata]),
					),
					readme: '# Registry README\nRead before choosing a version.',
				})
			if (request.url === `${item.registry}/${encodeURIComponent(item.name)}/${item.version}`)
				return MiniflareResponse.json(item.metadata)
			if (request.url === `${item.registry}/${encodeURIComponent(item.name)}/-/${item.version}.tgz`)
				return new MiniflareResponse(item.bytes)
			if (request.url === `${item.registry}/-/package/${encodeURIComponent(item.name)}/dist-tags`)
				return MiniflareResponse.json(item.tags)
		}
		if (url.pathname === '/redirect.tgz')
			return new MiniflareResponse(null, {
				status: 302,
				headers: { Location: 'https://unexpected.example/file.tgz' },
			})
		return new MiniflareResponse('Not found', { status: 404 })
	}

	async function start(hostedUrl?: string, port = 0) {
		runtime = new Miniflare({
			host: '127.0.0.1',
			port,
			resourcePersistencePath: directory,
			workers: [
				{
					config: {
						name: 'plugin-market-test',
						compatibilityDate: '2026-11-03',
						compatibilityFlags: [
							'enable_request_signal',
							'no_nodejs_compat',
							'no_nodejs_compat_v2',
						],
						manifest: {
							mainModule: workerModule,
							modules: { [workerModule]: { type: 'esm', contents: script } },
						},
						env: {
							DB: { type: 'd1', id: 'plugin-market-test' },
							ADMIN_TOKEN: { type: 'text', value: token },
							REGISTRIES: {
								type: 'text',
								value: JSON.stringify(
									hostedUrl
										? [
												...sources,
												{
													registry: hostedUrl,
													access: 'admin',
													notificationIndexing: 'unsigned',
													token: 'hosted-read',
													githubPublishers: [githubPublisherRule],
												},
											]
										: sources,
								),
							},
							...(hostedUrl
								? {
										HOSTED_REGISTRY_URL: { type: 'text' as const, value: hostedUrl },
										HOSTED_ARCHIVES: { type: 'r2' as const, name: 'hosted-archives' },
										HOSTED_PUBLISHERS: {
											type: 'text' as const,
											value: JSON.stringify([githubPublisherRule]),
										},
										HOSTED_READ_TOKEN: { type: 'text' as const, value: 'hosted-read' },
										MARKET_REVIEW: { type: 'text' as const, value: '{"requireLicense":true}' },
									}
								: {}),
						},
					},
					dev: {
						outboundService: {
							type: 'fetcher',
							handler(request) {
								requests.push(request.url)
								return registryReply(request)
							},
						},
					},
				},
			],
		})
		const address = await runtime.ready
		origin = new URL(address.href)
		db = connect(await runtime.getD1Database('DB'))
	}

	beforeAll(async () => {
		const pair = await generateKeyPair('RS256')
		signingKey = pair.privateKey
		signingJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key' }
		directory = await mkdtemp(join(tmpdir(), 'pluxel-market-'))
		script = await buildMarketWorker()
		await start()
		const binding = await runtime.getD1Database('DB')
		const migrationEntries = await readdir(new URL('../migrations/', import.meta.url))
		const files = migrationEntries.filter((name) => name.endsWith('.sql')).sort()
		for (const file of files) {
			const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
			await binding.batch(
				migration
					.split('--> statement-breakpoint')
					.filter((statement) => statement.trim())
					.map((statement) => binding.prepare(statement)),
			)
		}
	})

	afterAll(async () => {
		try {
			await runtime?.dispose()
		} finally {
			if (directory) await rm(directory, { recursive: true, force: true })
		}
	})

	beforeEach(async () => {
		await db.batch([
			db.delete(hostedTags),
			db.delete(hostedReleases),
			db.delete(audits),
			db.delete(releases),
			db.delete(notifications),
			db.delete(packages),
		])
		fixtures.clear()
		requests.length = 0
		github = githubRepository()
	})

	function admin(auth: string = token) {
		return newHttpBatchRpcSession<MarketAdmin>(
			new Request(new URL('/admin', origin).href, { headers: { Authorization: `Bearer ${auth}` } }),
		)
	}
	async function callAdmin<T>(call: (access: ReturnType<typeof admin>) => T) {
		using access = admin()
		return await call(access)
	}
	function get(path: string, headers?: Record<string, string>) {
		return fetch(new URL(path, origin).href, { headers })
	}
	async function getJson(path: string, headers?: Record<string, string>) {
		const response = await get(path, headers)
		expect(response.status).toBe(200)
		return response.json()
	}
	function notify(value: unknown = selected) {
		return fetch(new URL('/v1/notifications', origin).href, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(value),
		})
	}
	function signPublisher(audience: string, claims = {}, key = signingKey) {
		return new SignJWT({
			iss: githubIssuer,
			aud: audience,
			repository_id: githubPublisherRule.repositoryId,
			repository_owner_id: githubPublisherRule.repositoryOwnerId,
			workflow_ref: githubPublisherRule.workflowRef,
			job_workflow_ref: githubPublisherRule.jobWorkflowRef,
			ref: 'refs/heads/main',
			event_name: 'workflow_dispatch',
			run_id: '912345',
			run_attempt: '1',
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 60,
			...claims,
		})
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.sign(key)
	}

	const releasePath = `/v1/packages/${encodeURIComponent(selected.name)}/releases/${selected.version}`

	it('publishes to the hosted registry with npm and GitHub OIDC, then installs and indexes the same archive', async () => {
		const hostedUrl = `${origin.origin}/npm`
		const port = Number(origin.port)
		await runtime.dispose()
		await start(hostedUrl, port)
		const cwd = await mkdtemp(join(tmpdir(), 'pluxel-hosted-npm-'))
		try {
			const verified = await fixture(githubPublisherRule.name, {
				registry: hostedUrl,
				manifest: { license: 'MIT' },
			})
			const rejected = await fixture(verified.name, { registry: hostedUrl, version: '1.0.1' })
			const packagePath = `${hostedUrl}/${encodeURIComponent(verified.name)}`
			function publish(
				item: Fixture,
				bearer?: string,
				tag = 'latest',
				data = Buffer.from(item.bytes).toString('base64'),
			) {
				return fetch(packagePath, {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						...(bearer && { Authorization: `Bearer ${bearer}` }),
					},
					body: JSON.stringify({
						versions: {
							[item.version]: { name: item.name, version: item.version, license: 'MIT' },
						},
						'dist-tags': { [tag]: item.version },
						_attachments: {
							'plugin.tgz': {
								data,
								length: item.bytes.byteLength,
							},
						},
					}),
				})
			}
			await expect(publish(verified)).resolves.toMatchObject({ status: 401 })
			await expect(
				publish(verified, await signPublisher(`${origin.origin}/v1/notifications`)),
			).resolves.toMatchObject({ status: 401 })
			await expect(
				publish(verified, await signPublisher(hostedUrl, { repository_id: 'wrong' })),
			).resolves.toMatchObject({ status: 403 })

			const credential = await signPublisher(hostedUrl)
			const malformed = await publish(verified, credential, 'latest', 'invalid=base64')
			expect(malformed.status).toBe(400)
			await expect(malformed.json()).resolves.toMatchObject({ code: 'invalid-publish' })
			const denied = await publish(rejected, credential)
			expect(denied.status).toBe(422)
			await expect(denied.json()).resolves.toMatchObject({ code: 'review-license-required' })
			await expect(db.select().from(hostedReleases)).resolves.toEqual([])
			const npmrc = join(cwd, '.npmrc-test')
			await writeFile(npmrc, `//${origin.host}/npm/:_authToken=\${NODE_AUTH_TOKEN}\n`)
			await writeFile(join(cwd, 'plugin.tgz'), verified.bytes)
			await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true }))
			const npm = promisify(execFile)
			function runNpm(args: string[], authToken: string) {
				return npm('npm', [...args, '--registry', `${hostedUrl}/`, '--ignore-scripts'], {
					cwd,
					env: {
						...process.env,
						NPM_ID_TOKEN: undefined,
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
						ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
						NPM_CONFIG_USERCONFIG: npmrc,
						NPM_CONFIG_CACHE: join(cwd, 'cache'),
						NODE_AUTH_TOKEN: authToken,
					},
				})
			}
			await runNpm(
				['publish', './plugin.tgz', '--access=restricted', '--provenance=false'],
				credential,
			)
			const next = await fixture(verified.name, {
				registry: hostedUrl,
				version: '1.1.0',
				manifest: { license: 'MIT' },
			})
			const competing = await Promise.all([
				publish(next, credential, 'next'),
				publish(next, credential, 'next'),
			])
			expect(competing.map((response) => response.status).sort()).toEqual([201, 409])
			await expect(publish(verified, credential, 'preview')).resolves.toMatchObject({ status: 409 })
			await expect(fetch(packagePath)).resolves.toMatchObject({ status: 401 })
			const reader = { Authorization: 'Bearer hosted-read' }
			const packument = await fetch(packagePath, { headers: reader })
			expect(packument.status).toBe(200)
			const manifest = (await packument.json()) as {
				'dist-tags': Record<string, string>
				versions: Record<
					string,
					{ dist: { tarball: string; integrity: string; unpackedSize: number } }
				>
			}
			expect(manifest['dist-tags']).toEqual({ latest: verified.version, next: next.version })
			const dist = manifest.versions[verified.version].dist
			expect(dist.integrity).toBe(verified.integrity)
			expect(dist.unpackedSize).toBeGreaterThan(0)
			const archive = await fetch(dist.tarball, { headers: reader })
			expect(Buffer.from(await archive.arrayBuffer())).toEqual(Buffer.from(verified.bytes))
			expect(await db.select().from(hostedReleases)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						version: verified.version,
						publisher: expect.objectContaining({ runId: '912345' }),
					}),
				]),
			)
			const archives = await runtime.getR2Bucket('HOSTED_ARCHIVES')
			const storedArchives = await archives.list()
			expect(storedArchives.objects).toHaveLength(2)

			await runNpm(
				[
					'install',
					`${verified.name}@${verified.version}`,
					'--legacy-peer-deps',
					'--no-audit',
					'--no-fund',
					'--package-lock=false',
				],
				'hosted-read',
			)
			const installed = await readFile(
				join(cwd, 'node_modules', verified.name, 'package.json'),
				'utf8',
			)
			expect(JSON.parse(installed)).toMatchObject({
				name: verified.name,
				version: verified.version,
				license: 'MIT',
			})

			const endpoint = new URL('/v1/notifications', origin)
			const notificationToken = await signPublisher(endpoint.href)
			const notice = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${notificationToken}`,
				},
				body: JSON.stringify({
					registry: hostedUrl,
					name: verified.name,
					version: verified.version,
				}),
			})
			expect(notice.status).toBe(202)
			const receipt = (await notice.json()) as Receipt
			const receiptPath = `/v1/notifications/${receipt.id}`
			await expect(get(receiptPath)).resolves.toMatchObject({ status: 404 })
			await expect(
				get(receiptPath, { Authorization: `Bearer ${credential}` }),
			).resolves.toMatchObject({ status: 404 })
			const entry = await runtime.getWorker()
			expect(await entry.scheduled({ cron: '*/5 * * * *' })).toMatchObject({ outcome: 'ok' })
			expect(
				await getJson(receiptPath, { Authorization: `Bearer ${notificationToken}` }),
			).toMatchObject({ status: 'indexed' })
			expect(await callAdmin((session) => session.getNotification(receipt.id))).toMatchObject({
				status: 'indexed',
				githubPublisher: { runId: '912345' },
			})
			const path = `/v1/packages/${encodeURIComponent(verified.name)}/releases/${verified.version}?registry=${encodeURIComponent(hostedUrl)}`
			expect(await getJson(path, { Authorization: `Bearer ${token}` })).toMatchObject({
				integrity: verified.integrity,
			})
			await expect(get(path)).resolves.toMatchObject({ status: 404 })
			await fixture(selected.name, { registry: privateRegistry })
			expect(
				await callAdmin((session) => session.refresh({ ...selected, registry: privateRegistry })),
			).toMatchObject({
				status: 'failed',
				code: 'review-license-required',
			})
		} finally {
			await rm(cwd, { recursive: true, force: true })
			await runtime.dispose()
			await start()
		}
	}, 25_000)

	it('atomically settles a private unsigned receipt and keeps proof-bearing releases out of the catalog', async () => {
		const unsigned = await fixture(selected.name, { registry: privateRegistry })
		const signed = await fixture('@example/signed', { registry: privateRegistry })
		signed.metadata.dist = { ...(signed.metadata.dist as object), attestations: { url: 'proof' } }
		const received = await Promise.all(
			[unsigned, signed].map(async ({ registry: source, name, version }) => {
				const response = await fetch(new URL('/v1/notifications', origin), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer notify-private' },
					body: JSON.stringify({ registry: source, name, version }),
				})
				expect(response.status).toBe(202)
				return (await response.json()) as Receipt
			}),
		)
		const entry = await runtime.getWorker()
		expect(await entry.scheduled({ cron: '*/5 * * * *' })).toMatchObject({ outcome: 'ok' })
		expect(await callAdmin((session) => session.getNotification(received[0].id))).toMatchObject({
			status: 'indexed',
			attempts: 1,
			code: null,
		})
		expect(await callAdmin((session) => session.getNotification(received[1].id))).toMatchObject({
			status: 'failed',
			code: 'provenance-runtime-unsupported',
		})
		const path = `${releasePath}?registry=${encodeURIComponent(privateRegistry)}`
		expect(await getJson(path, { Authorization: `Bearer ${token}` })).toMatchObject({
			integrity: unsigned.integrity,
			provenance: { status: 'missing' },
		})
		await expect(get(path)).resolves.toMatchObject({ status: 404 })
		expect(await db.select().from(releases)).toMatchObject([{ name: unsigned.name }])
		expect(await db.select().from(audits)).toMatchObject([
			{ name: unsigned.name, action: 'refresh' },
		])
	})

	it('rejects all writes from an expired indexing lease', async () => {
		const input = { ...selected, registry: privateRegistry }
		const queued = await enqueue(db, input, 0)
		const task = await claim(db, queued.id, 0)
		expect(task).not.toBeNull()
		await expect(
			commitRelease(
				db,
				{
					...input,
					integrity: 'test',
					checkedAt: 1,
					tarball: `${privateRegistry}/test.tgz`,
					provenance: { status: 'missing' },
					peerDependencies: {},
					pluginPackages: {},
					readme: null,
					license: null,
				},
				{
					description: null,
					repository: null,
					metadataVersion: input.version,
					readme: null,
					license: null,
					distTags: {},
					observedAt: 1,
				},
				task!,
			),
		).rejects.toMatchObject({ code: 'notification-lease-lost' })
		expect(await db.select().from(packages)).toEqual([])
		expect(await db.select().from(releases)).toEqual([])
		expect(await db.select().from(audits)).toEqual([])
		expect(await db.select().from(notifications)).toMatchObject([{ status: 'processing' }])
	})

	it('fetches and verifies npm bytes before publishing a browsable, cacheable exact release', async () => {
		const item = await fixture()
		using session = admin()
		const indexed = await session.refresh(selected)
		expect(indexed).toMatchObject({
			status: 'indexed',
			release: { ...selected, integrity: item.integrity, provenance: { status: 'missing' } },
		})
		expect(requests).toHaveLength(3)
		const listing = await get('/v1/packages')
		expect(await listing.json()).toMatchObject({
			packages: [
				{
					name: selected.name,
					description: `Package ${selected.name}`,
					latest: '1.0.0',
					repository: 'https://github.com/unverified/claim',
					indexedVersions: 1,
				},
			],
			nextCursor: null,
		})
		const response = await get(releasePath)
		expect(await response.json()).toMatchObject({
			...selected,
			integrity: item.integrity,
			peerDependencies: { '@pluxel/core': '^1.0.0' },
		})
		const unchanged = await get(releasePath, { 'If-None-Match': response.headers.get('ETag')! })
		expect(unchanged.status).toBe(304)
		expect(await unchanged.text()).toBe('')
		expect(requests).toHaveLength(3)
	})

	it('authenticates administration and bounds RPC and notification input', async () => {
		using denied = admin('wrong-token')
		await expect(denied.refresh(selected)).rejects.toThrow(/401/)
		expect(requests).toHaveLength(0)
		for (const invalid of [
			{ ...selected, version: '^1.0.0' },
			{ ...selected, name: '../escape' },
			{ ...selected, repository: 'https://github.com/claim' },
		]) {
			await expect(notify(invalid)).resolves.toMatchObject({ status: 400 })
		}
		await expect(
			notify({ ...selected, registry: 'https://untrusted.example' }),
		).resolves.toMatchObject({ status: 422 })
		await expect(notify({ ...selected, padding: 'x'.repeat(5000) })).resolves.toMatchObject({
			status: 413,
		})
		const huge = await fetch(new URL('/admin', origin).href, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: 'x'.repeat(70_000),
		})
		expect(huge.status).toBe(413)
		expect(await db.select().from(notifications)).toHaveLength(0)
	})

	it('deduplicates durable notification receipts and reports the unavailable native proof gate honestly', async () => {
		const [first, second] = await Promise.all([notify(), notify()])
		expect([first.status, second.status]).toEqual([202, 202])
		const accepted = await first.json()
		expect(await second.json()).toEqual(accepted)
		using processing = admin()
		expect(await processing.processNotifications()).toEqual({ processed: 1 })
		const response = await get(first.headers.get('Location')!)
		const done = (await response.json()) as Receipt
		expect(done).toMatchObject({
			...selected,
			status: 'failed',
			attempts: 1,
			code: 'provenance-runtime-unsupported',
		})
		expect(done).not.toHaveProperty('diagnostic')
		const replay = await notify()
		expect(replay.status).toBe(200)
		expect(await replay.json()).toEqual(done)
		using retry = admin()
		expect(await retry.retryNotification(done.id)).toEqual({
			status: 'unavailable',
			code: 'provenance-runtime-unsupported',
		})
		expect(requests).toHaveLength(0)
		expect(await db.select().from(releases)).toHaveLength(0)
	})

	it('authenticates GitHub Actions notifications against the package and both workflow identities', async () => {
		const target = { ...selected, name: githubPublisherRule.name }
		const audience = new URL('/v1/notifications', origin).href
		const sign = (claims = {}, key = signingKey) => signPublisher(audience, claims, key)
		async function submit(jwt?: string, payload = target) {
			return fetch(new URL('/v1/notifications', origin), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(jwt && { Authorization: `Bearer ${jwt}` }),
				},
				body: JSON.stringify(payload),
			})
		}
		await expect(submit()).resolves.toMatchObject({ status: 401 })
		githubKeysAvailable = false
		try {
			const unavailable = await submit(await sign())
			expect(unavailable.status).toBe(503)
			await expect(unavailable.json()).resolves.toMatchObject({ code: 'github-oidc-unavailable' })
		} finally {
			githubKeysAvailable = true
		}
		const unrelatedKey = await generateKeyPair('RS256')
		for (const jwt of [
			await sign({}, unrelatedKey.privateKey),
			await sign({ iss: 'https://other-issuer.example' }),
			await sign({ aud: 'npm:registry.npmjs.org' }),
			await sign({ exp: Math.floor(Date.now() / 1000) - 60 }),
		]) {
			const response = await submit(jwt)
			expect(response.status).toBe(401)
			await expect(response.json()).resolves.toMatchObject({ code: 'github-oidc-invalid' })
		}
		for (const claims of [
			{ repository_id: '789' },
			{ repository_owner_id: '789' },
			{ workflow_ref: 'publisher/plugin/.github/workflows/other.yml@refs/heads/main' },
			{ job_workflow_ref: githubPublisherRule.jobWorkflowRef.replace(/a{40}$/, 'b'.repeat(40)) },
			{ ref: 'refs/pull/9/merge' },
			{ event_name: 'pull_request_target' },
		]) {
			const response = await submit(await sign(claims))
			expect(response.status).toBe(403)
			await expect(response.json()).resolves.toMatchObject({ code: 'github-oidc-publisher-denied' })
		}
		await expect(submit(await sign(), selected)).resolves.toMatchObject({ status: 403 })
		expect(await db.select().from(notifications)).toEqual([])

		const accepted = await submit(await sign())
		expect(accepted.status).toBe(202)
		const receipt = (await accepted.json()) as Receipt
		expect(receipt).toMatchObject({ ...target, status: 'pending' })
		expect(receipt).not.toHaveProperty('githubPublisher')
		await expect(submit()).resolves.toMatchObject({ status: 401 })
		const replay = await submit(await sign({ run_attempt: '2' }))
		await expect(replay.json()).resolves.toEqual(receipt)
		using operator = admin()
		await expect(operator.getNotification(receipt.id)).resolves.toMatchObject({
			githubPublisher: {
				workflowRef: githubPublisherRule.workflowRef,
				runId: '912345',
				runAttempt: '1',
			},
		})
		expect(requests.every((url) => url === `${githubIssuer}/.well-known/jwks`)).toBe(true)
	})

	it('uses the npm mirror for observations and archives while admitting canonical npm bytes and identity', async () => {
		const mirror = 'https://registry.npmmirror.com'
		const [source] = registrySources(JSON.stringify([{ registry, mirror, access: 'public' }]))
		const item = await fixture()
		const path = '/' + encodeURIComponent(item.name)
		const cdn = 'https://cdn.npmmirror.com/packages/example/1.0.0/plugin.tgz'
		const visited: string[] = []
		let location = cdn
		let corrupt = false
		source!.fetch = async (request) => {
			visited.push(request.url)
			expect(request.headers.has('Authorization')).toBe(false)
			if (request.url === mirror + path)
				return Response.json({
					name: item.name,
					'dist-tags': item.tags,
					versions: { [item.version]: item.metadata },
				})
			if (request.url === registry + path + '/' + item.version) return Response.json(item.metadata)
			if (request.url === mirror + path + '/-/' + item.version + '.tgz')
				return Response.redirect(location, 302)
			if (request.url === cdn)
				return new Response(corrupt ? 'other bytes' : new Uint8Array(item.bytes))
			if (request.url === mirror + '/-/package' + path + '/dist-tags')
				return Response.json(item.tags)
			throw new Error('unexpected mirror transport')
		}
		const inspect = () => fetchRelease(selected, source!, { review() {} })
		expect(await fetchObservation(selected, source!)).toMatchObject({
			metadataVersion: item.version,
		})
		expect(await inspect()).toMatchObject({
			release: {
				registry,
				integrity: item.integrity,
				tarball: (item.metadata.dist as { tarball: string }).tarball,
			},
		})
		expect(visited).toEqual([
			mirror + path,
			registry + path + '/' + item.version,
			mirror + path + '/-/' + item.version + '.tgz',
			cdn,
			mirror + '/-/package' + path + '/dist-tags',
		])
		corrupt = true
		await expect(inspect()).rejects.toMatchObject({ code: 'integrity-mismatch' })
		location = 'https://untrusted.example/package.tgz'
		await expect(inspect()).rejects.toMatchObject({ code: 'npm-redirect' })
		expect(visited).not.toContain(location)
		for (const config of [
			{ registry: privateRegistry, access: 'admin', mirror },
			{ registry, access: 'public', token: 'private', mirror },
		])
			expect(() => registrySources(JSON.stringify([config]))).toThrow(/mirror/)
	})

	it('never downgrades a present proof, follows redirects, or fetches arbitrary tarball origins', async () => {
		const item = await fixture()
		const dist = item.metadata.dist as Record<string, unknown>
		dist.attestations = { url: `${registry}/-/npm/v1/attestations/example` }
		using proof = admin()
		expect(await proof.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'provenance-runtime-unsupported',
		})
		expect(requests).toHaveLength(1)
		delete dist.attestations
		dist.tarball = 'https://localhost/private.tgz'
		using outside = admin()
		expect(await outside.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'disallowed-npm-url',
		})
		dist.tarball = `${registry}/redirect.tgz`
		using redirect = admin()
		expect(await redirect.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'npm-redirect',
		})
		expect(
			requests.some((url) => url.includes('unexpected.example') || url.includes('localhost')),
		).toBe(false)
		expect(await db.select().from(packages)).toHaveLength(0)
	})

	it('rejects digest mismatches, missing export files and unsafe tar paths before writing catalog state', async () => {
		const item = await fixture()
		;(item.metadata.dist as Record<string, unknown>).integrity = `sha512-${'A'.repeat(86)}==`
		using corrupt = admin()
		expect(await corrupt.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'integrity-mismatch',
		})
		await fixture(selected.name, { manifest: { exports: { '.': './dist/missing.mjs' } } })
		using missing = admin()
		expect(await missing.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'missing-export-file',
		})
		await fixture(selected.name, {
			extra: [{ header: { name: 'package/../escape', size: 0, type: 'file' }, body: '' }],
		})
		using unsafe = admin()
		expect(await unsafe.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'invalid-tarball-path',
		})
		await fixture(selected.name, {
			extra: [
				{
					header: {
						name: 'package/linked.mjs',
						type: 'symlink',
						linkname: 'dist/index.mjs',
						size: 0,
					},
				},
			],
		})
		using linked = admin()
		expect(await linked.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'invalid-tarball-entry',
		})
		expect(await db.select().from(packages)).toHaveLength(0)
		expect(await db.select().from(audits)).toHaveLength(0)
	})

	it('atomically admits one byte identity when conflicting first releases race', async () => {
		const first = {
			...selected,
			tarball: `${registry}/first.tgz`,
			integrity: 'first-digest',
			checkedAt: 1,
			provenance: { status: 'missing' as const },
			peerDependencies: {},
			pluginPackages: {},
			readme: null,
			license: null,
		}
		const second = {
			...first,
			tarball: `${registry}/second.tgz`,
			integrity: 'second-digest',
			checkedAt: 2,
		}
		const outcomes = await Promise.allSettled([
			commitRelease(db, first, {
				description: 'first',
				repository: null,
				metadataVersion: '1.0.0',
				readme: null,
				license: null,
				distTags: {},
				observedAt: 1,
			}),
			commitRelease(db, second, {
				description: 'second',
				repository: null,
				metadataVersion: '1.0.0',
				readme: null,
				license: null,
				distTags: {},
				observedAt: 2,
			}),
		])
		expect(outcomes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
		const [stored] = await db.select().from(releases)
		expect(await db.select().from(packages)).toMatchObject([
			{ description: stored.integrity === 'first-digest' ? 'first' : 'second' },
		])
		expect(await db.select().from(audits)).toHaveLength(1)
	})

	it('rejects changed bytes for an indexed version without overwriting its observation or audit', async () => {
		const original = await fixture()
		using first = admin()
		expect(await first.refresh(selected)).toMatchObject({ status: 'indexed' })
		const conflicting = await fixture(selected.name, { manifest: { description: 'Changed bytes' } })
		conflicting.tags = { latest: '9.0.0' }
		using second = admin()
		expect(await second.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'immutable-release-conflict',
		})
		const response = await get(releasePath)
		expect(await response.json()).toMatchObject({ integrity: original.integrity })
		expect(await db.select().from(packages)).toMatchObject([
			{ description: `Package ${selected.name}`, distTags: { latest: '1.0.0' } },
		])
		expect(await db.select().from(audits)).toHaveLength(1)
	})

	it('preserves actual latest tags, paginates in the database, and excludes hidden packages before paging', async () => {
		for (const name of ['@example/aa', '@example/ab', '@example/ac']) {
			const item = await fixture(name)
			item.tags = { latest: '2.0.0' }
			using session = admin()
			expect(await session.refresh({ ...selected, name })).toMatchObject({ status: 'indexed' })
		}
		const older = await fixture('@example/aa', { version: '1.1.0' })
		older.tags = { latest: '2.0.0' }
		using another = admin()
		expect(
			await another.refresh({ ...selected, name: older.name, version: older.version }),
		).toMatchObject({ status: 'indexed' })
		using hidden = admin()
		expect(
			await hidden.setVisibility({
				registry,
				name: '@example/ab',
				expectedRevision: 1,
				hidden: true,
			}),
		).toMatchObject({ status: 'updated' })
		const firstResponse = await get('/v1/packages?query=%40example&limit=1')
		expect(firstResponse.status).toBe(200)
		const first = (await firstResponse.json()) as PackagePage
		expect(first.packages).toMatchObject([
			{ name: '@example/aa', latest: '2.0.0', indexedVersions: 2 },
		])
		const secondResponse = await get(
			`/v1/packages?query=%40example&limit=1&cursor=${first.nextCursor}`,
		)
		const second = (await secondResponse.json()) as PackagePage
		expect(second.packages).toMatchObject([{ name: '@example/ac', indexedVersions: 1 }])
		expect(second.nextCursor).toBeNull()
		await expect(get(`/v1/packages?query=other&cursor=${first.nextCursor}`)).resolves.toMatchObject(
			{ status: 400 },
		)
		await expect(get('/v1/packages/%40example%2Faa/releases/2.0.0')).resolves.toMatchObject({
			status: 404,
		})
		await expect(get('/v1/packages/%40example%2Fab/releases/1.0.0')).resolves.toMatchObject({
			status: 404,
		})
		const escaped = await get('/v1/packages?query=%25')
		expect(await escaped.json()).toMatchObject({ packages: [] })
		const versionsResponse = await get('/v1/packages/%40example%2Faa/releases?limit=1')
		const versions = (await versionsResponse.json()) as {
			releases: { version: string }[]
			nextCursor: string
		}
		expect(versions.releases).toMatchObject([{ version: '1.0.0' }])
		const nextVersions = await get(
			`/v1/packages/%40example%2Faa/releases?cursor=${versions.nextCursor}`,
		)
		expect(await nextVersions.json()).toMatchObject({
			releases: [{ version: '1.1.0' }],
			nextCursor: null,
			coverage: 'indexed-only',
		})
	})

	it('makes concurrent visibility changes compare revisions and creates only the winning audit', async () => {
		await fixture()
		using session = admin()
		await session.refresh(selected)
		using first = admin()
		using second = admin()
		const input = { registry, name: selected.name, expectedRevision: 1, hidden: true }
		const results = await Promise.all([first.setVisibility(input), second.setVisibility(input)])
		expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'updated'])
		expect(await db.select().from(audits)).toHaveLength(2)
		using refresh = admin()
		await refresh.refresh(selected)
		await expect(get(releasePath)).resolves.toMatchObject({ status: 404 })
		expect(await db.select().from(packages)).toMatchObject([{ hidden: true, revision: 2 }])
	})

	it('rejects stale leases and bounds retries including a crashed final attempt', async () => {
		const original = await enqueue(db, selected, 0)
		const [a, b] = await Promise.all([claim(db, original.id, 0), claim(db, original.id, 0)])
		const first = a ?? b
		expect([a, b].filter(Boolean)).toHaveLength(1)
		const recovered = await claim(db, original.id, 60_000)
		expect(recovered?.attempts).toBe(2)
		expect(
			await failAttempt(db, first!, new MarketError('network', 'Temporary', 502, true), 60_001),
		).toBe(false)
		expect(
			await failAttempt(db, recovered!, new MarketError('network', 'Temporary', 502, true), 60_001),
		).toBe(true)
		const stored = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, original.id))
			.get()
		expect(stored).toMatchObject({ status: 'pending', attempts: 2, nextAttemptAt: 180_001 })
		expect(await claim(db, original.id, 180_000)).toBeNull()
		const final = await claim(db, original.id, 180_001)
		expect(final?.attempts).toBe(maxAttempts)
		expect(await pendingNotifications(db, 240_001)).toEqual([])
		expect(await db.select().from(notifications)).toMatchObject([
			{ status: 'failed', code: 'attempts-exhausted' },
		])
	})

	it('enforces per-package notification capacity atomically and still returns duplicate receipts', async () => {
		const responses = await Promise.all(
			Array.from({ length: 12 }, (_, index) => notify({ ...selected, version: `1.0.${index}` })),
		)
		expect(responses.filter((response) => response.status === 202)).toHaveLength(10)
		expect(responses.filter((response) => response.status === 429)).toHaveLength(2)
		const first = (await responses.find((response) => response.status === 202)!.json()) as Receipt
		await expect(
			notify({ registry, name: first.name, version: first.version }),
		).resolves.toMatchObject({ status: 202 })
		expect(await db.select().from(notifications)).toHaveLength(10)
	})

	it('restores accepted receipts after recreating the Worker', async () => {
		const accepted = await notify()
		const body = await accepted.json()
		const location = accepted.headers.get('Location')!
		await runtime.dispose()
		await start()
		const restored = await get(location)
		expect(await restored.json()).toEqual(body)
		const duplicate = await notify()
		expect(await duplicate.json()).toEqual(body)
	})

	it('keeps same-name packages, notifications, and curation scoped to their real registry', async () => {
		const publicItem = await fixture('@pluxel/plugin-example')
		const privateItem = await fixture(publicItem.name, {
			registry: privateRegistry,
			manifest: {
				description: 'Private replacement',
				official: true,
				author: 'unverified',
				repository: 'https://github.com/PrivateOwner/plugin',
			},
		})
		const publicCoordinate = { ...selected, name: publicItem.name }
		const privateCoordinate = { ...publicCoordinate, registry: privateRegistry }
		{
			using publicAdmin = admin()
			expect(await publicAdmin.refresh(publicCoordinate)).toMatchObject({ status: 'indexed' })
		}
		{
			using privateAdmin = admin()
			expect(await privateAdmin.refresh(privateCoordinate)).toMatchObject({ status: 'indexed' })
		}
		const path = `/v1/packages/${encodeURIComponent(publicItem.name)}/releases/1.0.0`
		expect(await getJson(path)).toMatchObject({
			registry,
			integrity: publicItem.integrity,
		})
		await expect(
			get(`${path}?registry=${encodeURIComponent(privateRegistry)}`),
		).resolves.toMatchObject({ status: 404 })
		const privateRead = await get(`${path}?registry=${encodeURIComponent(privateRegistry)}`, {
			Authorization: `Bearer ${token}`,
		})
		expect(privateRead.headers.get('Cache-Control')).toBe('no-store')
		expect(await privateRead.json()).toMatchObject({
			registry: privateRegistry,
			integrity: privateItem.integrity,
		})
		expect(await getJson('/v1/packages')).toMatchObject({
			packages: [{ registry, name: publicItem.name, official: false }],
		})
		const both = (await getJson('/v1/packages', {
			Authorization: `Bearer ${token}`,
		})) as PackagePage
		expect(both.packages).toHaveLength(2)
		expect(new Set(both.packages.map((item) => item.registry))).toEqual(
			new Set([registry, privateRegistry]),
		)
		const privateOwner = '/v1/packages?author=github%3Aowner%2Fprivateowner'
		expect(await getJson(privateOwner)).toMatchObject({ packages: [] })
		expect(await getJson(privateOwner, { Authorization: `Bearer ${token}` })).toMatchObject({
			packages: [
				{ name: publicItem.name, registry: privateRegistry, author: { name: '@PrivateOwner' } },
			],
		})
		const first = await notify(publicCoordinate)
		const publicReceipt = (await first.json()) as Receipt
		const submitPrivate = (authorization?: string) =>
			fetch(new URL('/v1/notifications', origin), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(authorization ? { Authorization: authorization } : {}),
				},
				body: JSON.stringify(privateCoordinate),
			})
		await expect(submitPrivate()).resolves.toMatchObject({ status: 401 })
		const accepted = await submitPrivate('Bearer notify-private')
		const privateReceipt = (await accepted.json()) as Receipt
		expect(privateReceipt.id).not.toBe(publicReceipt.id)
		expect(privateReceipt.registry).toBe(privateRegistry)
		await expect(get(`/v1/notifications/${privateReceipt.id}`)).resolves.toMatchObject({
			status: 404,
		})
		expect(
			await getJson(`/v1/notifications/${privateReceipt.id}`, {
				Authorization: 'Bearer notify-private',
			}),
		).toEqual(privateReceipt)
		await expect(
			get('/v1/packages', { Authorization: 'Bearer notify-private' }),
		).resolves.toMatchObject({ status: 401 })
		const capabilities = JSON.stringify(await getJson('/v1'))
		expect(capabilities).not.toContain(privateRegistry)
		expect(capabilities).not.toContain('read-private')
		expect(capabilities).not.toContain('notify-private')
		privateItem.metadata.dist = {
			...(privateItem.metadata.dist as object),
			tarball:
				publicItem.metadata.dist && (publicItem.metadata.dist as { tarball: string }).tarball,
		}
		{
			using rejected = admin()
			expect(await rejected.refresh(privateCoordinate)).toMatchObject({
				status: 'failed',
				code: 'disallowed-npm-url',
			})
		}
	})

	it('searches indexed descriptions and market tags, filters curation, and preserves it across refreshes', async () => {
		await fixture('@pluxel/plugin-example', {
			manifest: {
				description: 'HTTP transport integration',
				official: true,
				category: 'forged',
				tags: ['forged'],
				author: 'Someone else',
			},
		})
		const identity = { registry, name: '@pluxel/plugin-example' }
		{
			using indexing = admin()
			await indexing.refresh({ ...identity, version: '1.0.0' })
		}
		{
			using curation = admin()
			expect(
				await curation.setMetadata({
					...identity,
					expectedRevision: 1,
					official: true,
					category: 'integration',
					tags: ['network', 'http'],
				}),
			).toMatchObject({ status: 'updated', record: { revision: 2, tags: ['http', 'network'] } })
		}
		const beforeSearch = requests.length
		for (const query of ['transport', 'netw', 'HTTP transport', 'pluxel example']) {
			const response = await get(
				`/v1/packages?query=${encodeURIComponent(query)}&official=true&category=integration&tag=http`,
			)
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({
				packages: [
					{ ...identity, official: true, category: 'integration', tags: ['http', 'network'] },
				],
			})
		}
		for (const query of ['forged', 'missing', '%']) {
			expect(await getJson(`/v1/packages?query=${encodeURIComponent(query)}`)).toMatchObject({
				packages: [],
			})
		}
		expect(requests).toHaveLength(beforeSearch)
		expect(await getJson('/v1/facets')).toEqual({
			total: 1,
			registries: [{ value: registry, count: 1 }],
			categories: [{ value: 'integration', count: 1 }],
			tags: [
				{ value: 'http', count: 1 },
				{ value: 'network', count: 1 },
			],
			authors: [
				{
					id: 'github:owner/unverified',
					name: '@unverified',
					kind: 'github',
					avatarUrl: null,
					count: 1,
				},
			],
		})
		{
			using stale = admin()
			expect(
				await stale.setMetadata({
					...identity,
					expectedRevision: 1,
					official: false,
					category: null,
					tags: [],
				}),
			).toEqual({ status: 'conflict', currentRevision: 2 })
		}
		{
			using refresh = admin()
			await refresh.refresh({ ...identity, version: '1.0.0' })
		}
		{
			using read = admin()
			expect(await read.getPackage(identity)).toMatchObject({
				revision: 2,
				official: true,
				category: 'integration',
				tags: ['http', 'network'],
			})
		}
		{
			using audit = admin()
			const changes = await audit.recentChanges(identity)
			expect(changes.filter((change) => change.action === 'metadata')).toMatchObject([
				{
					revision: 2,
					changes: { official: true, category: 'integration', tags: ['http', 'network'] },
				},
			])
		}
		{
			using hidden = admin()
			await hidden.setVisibility({ ...identity, expectedRevision: 2, hidden: true })
		}
		expect(await getJson('/v1/facets')).toEqual({
			total: 0,
			registries: [],
			categories: [],
			tags: [],
			authors: [],
		})
		expect(await getJson('/v1/packages?query=network')).toMatchObject({ packages: [] })
	})

	it('combines multiple values per facet, counts across pages, and keeps hidden and private rows out', async () => {
		const entries = [
			{ name: 'alpha', category: 'storage', tags: ['http', 'telemetry'], author: 'alice' },
			{ name: 'beta', category: 'tools', tags: ['telemetry'], author: 'bob' },
			{ name: 'gamma', category: 'tools', tags: ['telemetry'], author: 'carol' },
			{ name: 'delta', category: 'games', tags: ['http'], author: 'bob' },
			{ name: 'epsilon', category: 'tools', tags: ['automation'], author: 'bob' },
			{
				name: 'other',
				category: 'tools',
				tags: ['telemetry'],
				author: 'query-mismatch',
				description: 'Other',
			},
			{ name: 'hidden', category: 'tools', tags: ['telemetry'], author: 'hidden', hidden: true },
			{
				name: 'alpha',
				category: 'tools',
				tags: ['telemetry'],
				author: 'private',
				registry: privateRegistry,
			},
		]
		for (const entry of entries) {
			const name = `@browse/${entry.name}`
			const source = entry.registry ?? registry
			const { metadata } = await fixture(name, { registry: source })
			metadata.description = entry.description ?? 'Service transport'
			metadata.repository = `https://github.com/${entry.author}/project`
			metadata.author = 'Unrelated registry text'
			expect(await callAdmin((access) => access.observe({ registry: source, name }))).toMatchObject(
				{ status: 'observed' },
			)
			expect(
				await callAdmin((access) =>
					access.setMetadata({
						registry: source,
						name,
						expectedRevision: 1,
						official: false,
						category: entry.category,
						tags: entry.tags,
					}),
				),
			).toMatchObject({ status: 'updated' })
			if (entry.hidden)
				await callAdmin((access) =>
					access.setVisibility({ registry: source, name, expectedRevision: 2, hidden: true }),
				)
		}

		const params = new URLSearchParams([
			['query', 'transport'],
			['official', 'false'],
			['registry', registry],
			['registry', privateRegistry],
			['category', 'storage'],
			['category', 'tools'],
			['tag', 'http'],
			['tag', 'telemetry'],
			['author', 'github:owner/alice'],
			['author', 'github:owner/bob'],
		])
		const first = (await getJson(`/v1/packages?${params}&limit=1`)) as PackagePage
		expect(first.packages).toMatchObject([
			{ name: '@browse/alpha', author: { id: 'github:owner/alice' } },
		])
		expect(first.nextCursor).toBeTruthy()
		const reordered = new URLSearchParams([...params].toReversed())
		reordered.append('author', 'github:owner/bob')
		const second = (await getJson(
			`/v1/packages?${reordered}&limit=1&cursor=${first.nextCursor}`,
		)) as PackagePage
		expect(second.packages).toMatchObject([
			{ name: '@browse/beta', author: { id: 'github:owner/bob' } },
		])
		expect(second.nextCursor).toBeNull()
		const headers = { Authorization: `Bearer ${token}` }
		await expect(
			get(`/v1/packages?${params}&limit=1&cursor=${first.nextCursor}`, headers),
		).resolves.toMatchObject({ status: 400 })
		const different = new URLSearchParams(params)
		different.append('author', 'github:owner/carol')
		await expect(
			get(`/v1/packages?${different}&limit=1&cursor=${first.nextCursor}`),
		).resolves.toMatchObject({ status: 400 })
		const combined = (await getJson(`/v1/facets?${params}`)) as CatalogFacets
		expect(combined).toEqual({
			total: 2,
			registries: [{ value: registry, count: 2 }],
			categories: [
				{ value: 'games', count: 1 },
				{ value: 'storage', count: 1 },
				{ value: 'tools', count: 1 },
			],
			tags: [
				{ value: 'automation', count: 1 },
				{ value: 'http', count: 1 },
				{ value: 'telemetry', count: 2 },
			],
			authors: ['alice', 'bob', 'carol'].map((name) => ({
				id: `github:owner/${name}`,
				name: '@' + name,
				kind: 'github',
				avatarUrl: null,
				count: 1,
			})),
		})
		const authenticated = (await getJson(`/v1/facets?${params}`, headers)) as CatalogFacets
		expect(authenticated.authors.map(({ id }) => id)).toEqual([
			'github:owner/alice',
			'github:owner/bob',
			'github:owner/carol',
			'github:owner/private',
		])
		params.append('author', 'github:owner/private')
		const bothSources = (await getJson(`/v1/packages?${params}`, headers)) as PackagePage
		expect(bothSources.packages.map(({ name, registry: source }) => [name, source])).toEqual([
			['@browse/alpha', privateRegistry],
			['@browse/alpha', registry],
			['@browse/beta', registry],
		])

		for (const path of [
			'/v1/facets?cursor=anything',
			'/v1/packages?official=false&official=true',
			'/v1/packages?author=github:0',
			`/v1/packages?${new URLSearchParams(Array.from({ length: 21 }, () => ['tag', 'http']))}`,
		])
			await expect(get(path)).resolves.toMatchObject({ status: 400 })
	})

	it('lists actionable notifications with stable tied-time paging and query-bound cursors', async () => {
		const rows = await Promise.all(
			['1.0.0', '1.1.0', '1.2.0'].map((version) => enqueue(db, { ...selected, version }, 100)),
		)
		const task = await claim(db, rows[0].id, 100)
		await failAttempt(
			db,
			task!,
			new MarketError('invalid-package', 'Fix the package before a bounded manual retry', 422),
			101,
		)
		let next: string | null = null
		let firstCursor: string | undefined
		const seen: string[] = []
		do {
			using session = admin()
			const page = await session.listNotifications({
				name: selected.name,
				limit: 1,
				...(next ? { cursor: next } : {}),
			})
			expect(page.notifications).toHaveLength(1)
			seen.push(page.notifications[0].id)
			expect(page.notifications[0]).not.toHaveProperty('leaseToken')
			next = page.nextCursor
			firstCursor ??= next ?? undefined
		} while (next)
		expect(new Set(seen)).toEqual(new Set(rows.map((row) => row.id)))
		{
			using mismatch = admin()
			await expect(
				mismatch.listNotifications({ status: 'failed', cursor: firstCursor }),
			).rejects.toThrow(/cursor|query/i)
		}
		{
			using failed = admin()
			expect(
				await failed.listNotifications({ registry, status: 'failed', code: 'invalid-package' }),
			).toMatchObject({
				notifications: [
					{
						id: task!.id,
						diagnostic: 'Fix the package before a bounded manual retry',
						retry: 'available',
					},
				],
				nextCursor: null,
			})
		}
		{
			using retry = admin()
			expect(await retry.retryNotification(task!.id)).toMatchObject({
				status: 'queued',
				receipt: { attempts: 1 },
			})
		}
		{
			using changed = admin()
			expect(await changed.getNotification(task!.id)).toMatchObject({
				status: 'pending',
				retry: 'not-failed',
			})
		}
		{
			using invalid = admin()
			await expect(invalid.listNotifications({ limit: 51 })).rejects.toThrow(/limit/)
		}
	})

	it('observes legacy npm packages for browsing without fabricating a checked release or provenance', async () => {
		const item = await fixture('@pluxel/legacy', {
			manifest: { peerDependencies: { '@pluxel/runtime': '^1.0.0' } },
		})
		Object.assign(item.metadata, {
			description: 'Public legacy plugin',
			repository: { url: 'git+https://github.com/unverified/claim.git' },
			license: 'MIT',
		})
		Object.assign(item.metadata.dist as object, {
			attestations: { url: `${registry}/attestation` },
		})
		{
			using observe = admin()
			expect(await observe.observe({ registry, name: item.name })).toMatchObject({
				status: 'observed',
			})
		}
		expect(await getJson('/v1/packages?query=legacy')).toMatchObject({
			packages: [
				{
					registry,
					name: item.name,
					indexedVersions: 0,
					repository: 'https://github.com/unverified/claim',
					repositoryStars: null,
					author: {
						id: 'github:owner/unverified',
						name: '@unverified',
						kind: 'github',
						avatarUrl: null,
					},
				},
			],
		})
		const detail = await getJson(`/v1/packages/${encodeURIComponent(item.name)}`)
		expect(detail).not.toHaveProperty('checkedRequirements')
		expect(detail).toMatchObject({
			metadataVersion: '1.0.0',
			readme: { text: '# Registry README\nRead before choosing a version.', truncated: false },
			license: 'MIT',
			indexedVersions: 0,
		})
		await expect(
			get(`/v1/packages/${encodeURIComponent(item.name)}/releases/1.0.0`),
		).resolves.toMatchObject({ status: 404 })
		{
			using refresh = admin()
			expect(await refresh.refresh({ registry, name: item.name, version: '1.0.0' })).toMatchObject({
				status: 'failed',
				code: 'provenance-runtime-unsupported',
			})
		}
		expect(await db.select().from(releases)).toEqual([])
		expect(await db.select().from(notifications)).toEqual([])
	})

	it('projects requirements only from the checked archive at the observed package coordinate', async () => {
		const checked = await fixture(selected.name, {
			manifest: {
				peerDependencies: { '@pluxel/core': '^1', '@example/metrics': '^2' },
				peerDependenciesMeta: { '@example/metrics': { optional: true } },
				pluxel: { pluginPackages: { '@example/metrics': 'optional' } },
			},
		})
		const next = await fixture(selected.name, { version: '2.0.0' })
		checked.tags.latest = next.version
		await callAdmin((access) => access.refresh(selected))
		const path = '/v1/packages/' + encodeURIComponent(selected.name)
		expect(await getJson(path)).toMatchObject({
			latest: next.version,
			metadataVersion: selected.version,
			checkedRequirements: {
				version: selected.version,
				peerDependencies: { '@pluxel/core': '^1', '@example/metrics': '^2' },
				pluginPackages: { '@example/metrics': 'optional' },
			},
		})
		await fixture(selected.name, { registry: privateRegistry, version: next.version })
		await callAdmin((access) =>
			access.refresh({ ...selected, registry: privateRegistry, version: next.version }),
		)
		await callAdmin((access) => access.observe({ registry, name: selected.name }))
		const observed = await getJson(path)
		expect(observed).toMatchObject({ metadataVersion: next.version, indexedVersions: 1 })
		expect(observed).not.toHaveProperty('checkedRequirements')
	})

	it('stores real repository observations and packaged README previews without conflating provenance or unknown stars', async () => {
		const text = '# Plugin README\n<script>never execute this</script>'
		await fixture(selected.name, {
			manifest: { license: 'MIT' },
			extra: [
				{ header: { name: 'package/README.md', type: 'file', size: text.length }, body: text },
			],
		})
		{
			using refresh = admin()
			await refresh.refresh(selected)
		}
		expect(await getJson(releasePath)).toMatchObject({
			readme: { text, truncated: false },
			license: 'MIT',
			provenance: { status: 'missing' },
		})
		const identity = { registry, name: selected.name }
		{
			using stars = admin()
			expect(await stars.refreshRepository(identity)).toMatchObject({
				status: 'updated',
				stars: 42,
			})
		}
		const listing = (await getJson('/v1/packages')) as PackagePage
		const observedAuthor = {
			id: 'github:owner/unverified',
			name: '@unverified',
			kind: 'github',
			avatarUrl: 'https://avatars.githubusercontent.com/u/128?v=4',
		}
		expect(listing.packages[0]).toMatchObject({
			repositoryStars: 42,
			repositoryObservedAt: expect.any(Number),
			author: observedAuthor,
		})
		expect(await getJson(`/v1/packages/${encodeURIComponent(selected.name)}`)).toMatchObject({
			author: observedAuthor,
		})
		expect(await getJson('/v1/facets?author=github%3Aowner%2Funverified')).toMatchObject({
			total: 1,
			authors: [{ ...observedAuthor, count: 1 }],
		})
		github.status = 429
		{
			using limited = admin()
			expect(await limited.refreshRepository(identity)).toMatchObject({
				status: 'failed',
				code: 'repository-unavailable',
				retryable: true,
			})
		}
		{
			using refreshing = admin()
			await refreshing.refresh(selected)
		}
		const after = (await getJson('/v1/packages')) as PackagePage
		expect(after.packages[0].repositoryStars).toBe(42)
		expect(after.packages[0].repositoryObservedAt).toBe(listing.packages[0].repositoryObservedAt)
		expect(after.packages[0].author).toEqual(observedAuthor)
		const count = requests.length
		await getJson('/v1/packages')
		await getJson('/v1/packages?query=plugin')
		await getJson('/v1/facets')
		expect(requests).toHaveLength(count)
	})

	it('groups by declared repository namespace independently of npm author, curation and GitHub availability', async () => {
		const old = await fixture('@example/previous')
		const other = await fixture('@example/current')
		old.metadata.repository = 'https://github.com/Unverified/claim'
		other.metadata.repository = 'https://github.com/unverified/another'
		old.metadata.author = { name: 'Impersonated organization' }
		other.metadata.author = 'Registry-local user'
		const previous = { registry, name: old.name }
		const current = { registry, name: other.name }
		await callAdmin((access) => access.observe(previous))
		await callAdmin((access) => access.observe(current))
		const filter = '?author=github%3Aowner%2Funverified'
		expect(
			((await getJson('/v1/packages' + filter)) as PackagePage).packages.map((pkg) => pkg.name),
		).toEqual([other.name, old.name])
		github.status = 403
		expect(await callAdmin((access) => access.refreshRepository(current))).toMatchObject({
			status: 'failed',
		})
		expect(await getJson('/v1/facets' + filter)).toMatchObject({
			total: 2,
			authors: [{ id: 'github:owner/unverified', count: 2, avatarUrl: null }],
		})
		github.status = 200
		expect(await callAdmin((access) => access.refreshRepository(previous))).toMatchObject({
			status: 'updated',
		})
		expect(await getJson('/v1/facets' + filter)).toMatchObject({
			authors: [
				{ id: 'github:owner/unverified', count: 2, avatarUrl: github.body.owner.avatar_url },
			],
		})

		const curation = {
			...previous,
			official: true,
			category: 'tools',
			tags: ['example'],
			expectedRevision: 1,
		}
		const manual = { ...curation, author: { id: 'market:team', name: 'Someone else' } }
		expect(await callAdmin((access) => access.setMetadata(manual))).toEqual({ status: 'invalid' })
		expect(await callAdmin((access) => access.setMetadata(curation))).toMatchObject({
			status: 'updated',
		})
		expect(await callAdmin((access) => access.setMetadata(curation))).toEqual({
			status: 'conflict',
			currentRevision: 2,
		})
		old.metadata.repository = 'https://github.com/Renamed/claim'
		await callAdmin((access) => access.observe(previous))
		const path = '/v1/packages/' + encodeURIComponent(old.name)
		expect(await getJson(path)).toMatchObject({
			official: true,
			author: { id: 'github:owner/renamed', name: '@Renamed', avatarUrl: null },
			repositoryStars: null,
			repositoryObservedAt: null,
		})
		github.body.full_name = 'renamed/claim'
		github.body.owner.login = 'renamed'
		github.body.owner.avatar_url = 'https://tracker.example/avatar'
		expect(await callAdmin((access) => access.refreshRepository(previous))).toMatchObject({
			status: 'updated',
		})
		expect(await getJson(path)).toMatchObject({
			repositoryStars: 42,
			author: { id: 'github:owner/renamed', avatarUrl: null },
		})
		old.metadata.repository = 'https://git.example/Unverified/claim'
		await callAdmin((access) => access.observe(previous))
		expect(await getJson(path)).toMatchObject({
			author: null,
			repositoryStars: null,
			repositoryObservedAt: null,
		})
		expect(await getJson('/v1/facets')).toMatchObject({
			authors: [{ id: 'github:owner/unverified', count: 1, avatarUrl: null }],
		})
	})

	it('revalidates snapshots without exporting rows and discards a validator overtaken by a write', async () => {
		await fixture()
		await callAdmin((access) => access.refresh(selected))
		await db.update(packages).set({ readme: { text: 'x'.repeat(256 * 1024), truncated: false } })
		const initial = await get('/v1/snapshot')
		const tag = initial.headers.get('ETag')!
		const body = await initial.arrayBuffer()
		expect(body.byteLength).toBeGreaterThan(256 * 1024)
		const request = new Request(new URL('/v1/snapshot', origin), {
			headers: { 'If-None-Match': `"unrelated", W/${tag}` },
		})
		const readBatch = db.batch.bind(db)
		const batch = vi.spyOn(db, 'batch')
		try {
			const hit = await catalogSnapshotResponse(request, db, [registry])
			expect(hit.status).toBe(304)
			expect(hit.headers.get('ETag')).toBe(tag)
			expect(await hit.text()).toBe('')
			expect(batch).not.toHaveBeenCalled()

			await db.update(releases).set({ license: 'ISC' })
			const edited = await get('/v1/snapshot', { 'If-None-Match': tag })
			expect(edited.status).toBe(200)
			expect(await edited.json()).toMatchObject({ releases: [{ license: 'ISC' }] })

			const other = await catalogSnapshotResponse(request, db, [privateRegistry])
			expect(other.status).toBe(200)
			expect(await other.json()).toMatchObject({ registries: [privateRegistry], packages: [] })
			await db.update(packages).set({ description: 'before concurrent write' })
			batch.mockImplementationOnce(async (queries) => {
				const snapshot = await readBatch(queries)
				await db.update(packages).set({ hidden: true })
				return snapshot
			})
			const previous = await catalogSnapshotResponse(request, db, [registry])
			expect(await previous.json()).toMatchObject({
				packages: [{ description: 'before concurrent write' }],
			})
			const latest = await get('/v1/snapshot', { 'If-None-Match': previous.headers.get('ETag')! })
			expect(latest.status).toBe(200)
			expect(await latest.json()).toMatchObject({ packages: [], releases: [] })
		} finally {
			batch.mockRestore()
		}
	})

	it('serves a public mirror from committed SQLite data after the Worker goes offline', async () => {
		const visible = await fixture('@example/mirror')
		visible.tags = { ...visible.tags, constructor: visible.version }
		const hidden = await fixture('@example/hidden')
		const privateItem = await fixture(visible.name, { registry: privateRegistry })
		for (const item of [visible, hidden, privateItem])
			await callAdmin((access) =>
				access.refresh({ registry: item.registry, name: item.name, version: item.version }),
			)
		await callAdmin((access) =>
			access.setVisibility({ registry, name: hidden.name, expectedRevision: 1, hidden: true }),
		)
		const curation = {
			registry,
			name: visible.name,
			official: true,
			category: 'tools',
			tags: ['initial'],
		}
		await callAdmin((access) => access.setMetadata({ ...curation, expectedRevision: 1 }))
		const snapshot = await get('/v1/snapshot', { Authorization: `Bearer ${token}` })
		expect(snapshot.status).toBe(200)
		expect(await snapshot.json()).toMatchObject({
			version: 2,
			registries: [registry],
			packages: [
				{ name: visible.name, registry, repository: 'https://github.com/unverified/claim' },
			],
			releases: [{ name: visible.name, registry, integrity: visible.integrity }],
		})
		const condition = { 'If-None-Match': snapshot.headers.get('ETag')! }
		const cachedSnapshot = await get('/v1/snapshot', condition)
		expect(cachedSnapshot.status).toBe(304)

		const binary = join(directory, 'mirror.mjs')
		const file = join(directory, 'catalog.sqlite')
		const execute = promisify(execFile)
		await execute(process.execPath, ['dev/build-mirror.ts', binary], { timeout: 10_000 })
		const publisher = origin.href
		const sync = () =>
			execute(process.execPath, [binary, 'sync', publisher, file], {
				cwd: directory,
				timeout: 10_000,
			})
		const initial = await sync()
		expect(initial.stdout).toContain('1 packages, 1 releases')
		const unchanged = await sync()
		expect(unchanged.stdout).toContain('unchanged')
		const server = spawn(process.execPath, [binary, 'serve', file], {
			cwd: directory,
			env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		const stopped = once(server, 'close')
		const output = createInterface({ input: server.stdout })
		let errors = ''
		server.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			errors += chunk
		})
		let offline = false
		try {
			const [line] = await Promise.race([
				once(output, 'line', { signal: AbortSignal.timeout(10_000) }),
				stopped.then(() => {
					throw new Error(`Mirror exited before readiness: ${errors}`)
				}),
			])
			expect(line).toMatch(/^Market mirror ready: http:\/\/127\.0\.0\.1:\d+$/)
			const base = line.slice('Market mirror ready: '.length)
			const read = (path: string) => fetch(base + path, { signal: AbortSignal.timeout(5_000) })
			const readMirror = async (path: string) => {
				const response = await read(path)
				expect(response.status).toBe(200)
				return response.json()
			}
			const detail = `/v1/packages/${encodeURIComponent(visible.name)}`
			const hiddenDetail = `/v1/packages/${encodeURIComponent(hidden.name)}`
			const release = `${detail}/releases/${visible.version}`
			for (const path of [
				'/v1/packages?query=mirror&author=github%3Aowner%2Funverified',
				'/v1/facets',
				detail,
				`${detail}/releases`,
				release,
			])
				expect(await readMirror(path)).toEqual(await getJson(path))
			expect(await readMirror('/v1')).toMatchObject({
				registries: [{ registry, access: 'public' }],
				capabilities: { notifications: false },
			})
			const privateDetail = await read(`${detail}?registry=${encodeURIComponent(privateRegistry)}`)
			expect(privateDetail.status).toBe(404)
			const write = await fetch(`${base}/v1/notifications`, { method: 'POST' })
			expect(write.status).toBe(405)

			await callAdmin((access) =>
				access.setMetadata({ ...curation, expectedRevision: 2, tags: ['delta'] }),
			)
			await callAdmin((access) =>
				access.setVisibility({ registry, name: hidden.name, expectedRevision: 2, hidden: false }),
			)
			const trigger = 'reject_mirror_test_insert'
			{
				using sqlite = new DatabaseSync(file)
				sqlite.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON releases BEGIN
					SELECT RAISE(ABORT, 'mirror-sync-fixture'); END;`)
			}
			await expect(sync()).rejects.toThrow('mirror-sync-fixture')
			expect(await readMirror(detail)).toMatchObject({ tags: ['initial'] })
			expect(await readMirror(release)).toMatchObject({ integrity: visible.integrity })
			const stillHidden = await read(hiddenDetail)
			expect(stillHidden.status).toBe(404)
			{
				using sqlite = new DatabaseSync(file)
				sqlite.exec(`DROP TRIGGER ${trigger}`)
			}
			await sync()
			await runtime.dispose()
			offline = true
			await expect(sync()).rejects.toMatchObject({ code: 1 })
			expect(await readMirror('/v1/packages?query=delta')).toMatchObject({
				packages: [{ name: visible.name, tags: ['delta'] }],
			})
			expect(await readMirror(release)).toMatchObject({ integrity: visible.integrity })
			expect(await readMirror(hiddenDetail)).toMatchObject({ name: hidden.name })
		} finally {
			output.close()
			server.kill()
			await stopped
			if (offline) await start()
		}
	}, 40_000)
})
