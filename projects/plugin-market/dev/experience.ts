import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { newHttpBatchRpcSession } from 'capnweb'
import type { MarketAdmin } from '../src/admin.ts'
import type { NotificationDetail, PackagePage, Receipt, Release } from '../src/protocol.ts'
import { localRoot, readSession, repositoryRoot } from './session.ts'

const [command = 'prepare'] = process.argv.slice(2)
if (command !== 'prepare' && command !== 'verify') throw new Error('Use prepare or verify')
const session = await readSession()
const cli = resolve(repositoryRoot, 'packages/cli/bin/pluxel.mjs')
const runId = crypto.randomUUID().slice(0, 8)
const pluginRoot = resolve(localRoot, command === 'verify' ? `runs/${runId}` : 'plugin')
const name = `@market-demo/pluxel-plugin-${command === 'verify' ? runId : 'hello'}`
const packagePath = `/v1/packages/${encodeURIComponent(name)}`
const identity = { registry: session.registry, name }

function packageUrl(suffix = '') {
	return `${packagePath}${suffix}?${new URLSearchParams({ registry: session.registry })}`
}

function admin() {
	return newHttpBatchRpcSession<MarketAdmin>(
		new Request(new URL('/admin', session.marketUrl), {
			headers: { Authorization: `Bearer ${session.adminToken}` },
		}),
	)
}

async function run(program: string, args: string[]) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/^npm_config_(registry|userconfig|provenance)$/i.test(key),
		),
	)
	console.info(
		`> ${program === process.execPath ? 'pluxel' : program} ${args.filter((arg) => arg !== cli).join(' ')}`,
	)
	await new Promise<void>((accept, reject) => {
		const child = spawn(program, args, {
			cwd: pluginRoot,
			stdio: 'inherit',
			env: {
				...env,
				NPM_CONFIG_REGISTRY: session.registryUrl,
				NPM_CONFIG_USERCONFIG: resolve(pluginRoot, '.npmrc'),
				NPM_CONFIG_PROVENANCE: 'false',
				PLUXEL_MARKET_TOKEN: session.notificationToken,
			},
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) accept()
			else reject(new Error(`${program} failed: ${signal ?? code}`))
		})
	})
}

async function marketResponse(
	path: string,
	init: RequestInit = {},
	token: string | null = session.adminToken,
) {
	const headers = new Headers(init.headers)
	if (token) headers.set('Authorization', `Bearer ${token}`)
	return fetch(new URL(path, session.marketUrl), {
		...init,
		headers,
		signal: AbortSignal.timeout(30_000),
	})
}

async function marketJson<T>(path: string, init?: RequestInit, token?: string | null): Promise<T> {
	const response = await marketResponse(path, init, token)
	assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
	return (await response.json()) as T
}

async function prepare() {
	await mkdir(pluginRoot, { recursive: true })
	const registryUrl = new URL(session.registryUrl)
	await writeFile(
		resolve(pluginRoot, '.npmrc'),
		`registry=${registryUrl.href}\n//${registryUrl.host}${registryUrl.pathname}:_authToken=${session.registryToken}\nprovenance=false\n`,
		{ mode: 0o600 },
	)
	function quote(value: string) {
		return `'${value.replaceAll("'", "'\\''")}'`
	}
	await writeFile(
		resolve(pluginRoot, '.market.env'),
		[
			`export PLUXEL_MARKET_TOKEN=${quote(session.notificationToken)}`,
			`export PLUXEL_MARKET_URL=${quote(session.marketUrl)}`,
			`export MARKET_REGISTRY=${quote(session.registry)}`,
			'',
		].join('\n'),
		{ mode: 0o600 },
	)
	const core = JSON.parse(
		await readFile(resolve(repositoryRoot, 'packages/core/package.json'), 'utf8'),
	) as { version: string }
	const files = {
		'package.json': `${JSON.stringify(
			{
				name,
				version: '0.1.0',
				description: 'Local market publishing experience',
				type: 'module',
				exports: {
					'.': {
						'@pluxel/hmr': './src/hello.ts',
						types: './dist/index.d.mts',
						default: './dist/index.mjs',
					},
				},
				files: ['dist', '!**/*.map'],
				peerDependencies: { '@pluxel/core': `^${core.version}` },
				publishConfig: { registry: session.registryUrl, access: 'public', provenance: false },
			},
			null,
			2,
		)}\n`,
		'src/hello.ts': pluginSource('Hello from the first release'),
		'tsconfig.json': `${JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2023',
					module: 'ESNext',
					moduleResolution: 'bundler',
					lib: ['ES2024', 'ESNext.Disposable'],
					types: ['node'],
					strict: true,
					experimentalDecorators: true,
					skipLibCheck: true,
					noEmit: true,
				},
				include: ['src'],
			},
			null,
			2,
		)}\n`,
		'tsdown.config.ts':
			"export default { entry: { index: 'src/hello.ts' }, format: ['esm'], dts: { eager: true }, clean: true }\n",
	}
	for (const [file, contents] of Object.entries(files)) {
		await mkdir(resolve(pluginRoot, file, '..'), { recursive: true })
		try {
			await writeFile(resolve(pluginRoot, file), contents, { flag: 'wx' })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
	}
	// prepare is an explicit maintenance step: refresh the generated connection
	// setting after a Pitchfork port bump, preserving the author's other edits.
	const manifestPath = resolve(pluginRoot, 'package.json')
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
		publishConfig: { registry: string }
	}
	if (manifest.publishConfig.registry !== session.registryUrl) {
		manifest.publishConfig.registry = session.registryUrl
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
		console.info(`Updated demo publishConfig.registry to ${session.registryUrl}`)
	}
	const links = {
		'@pluxel/core': 'packages/core',
		'@pluxel/rolldown': 'packages/rolldown',
		'@types/node': 'node_modules/@types/node',
		'vite-plus': 'node_modules/vite-plus',
		'.bin/pluxel': 'packages/cli/bin/pluxel.mjs',
	}
	for (const [target, source] of Object.entries(links)) {
		const destination = resolve(pluginRoot, 'node_modules', target)
		await mkdir(resolve(destination, '..'), { recursive: true })
		try {
			await symlink(resolve(repositoryRoot, source), destination)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
	}
}

function pluginSource(message: string) {
	return `import { BasePlugin, Plugin } from '@pluxel/core'\n\n@Plugin()\nexport class HelloPlugin extends BasePlugin {\n\tmessage(): string { return ${JSON.stringify(message)} }\n}\n`
}

await prepare()
console.info(`Editable plugin: ${pluginRoot}`)
console.info(`Market: ${session.publicUrl}/v1; PNPR: ${session.registryUrl}`)
if (command === 'prepare') {
	console.info(`Next: cd ${pluginRoot}`)
	console.info('. ./.market.env')
	console.info('vp exec pluxel build')
	console.info('vp exec pluxel publish --webhook --market-url "$PLUXEL_MARKET_URL"')
} else {
	const steps: string[] = []
	function passed(message: string) {
		steps.push(message)
		console.info(`PASS ${message}`)
	}
	await run(process.execPath, [cli, 'build'])
	await run(process.execPath, [cli, 'publish', '--webhook', '--market-url', session.marketUrl])
	const notificationBody = JSON.stringify({ ...identity, version: '0.1.0' })
	const notificationResponse = await marketResponse(
		'/v1/notifications',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: notificationBody,
		},
		session.notificationToken,
	)
	assert.equal(notificationResponse.status, 202)
	const receipt = (await notificationResponse.json()) as Receipt
	assert.equal(receipt.registry, session.registry)
	assert.equal(receipt.status, 'pending')
	const absent = await marketResponse(packageUrl())
	assert.equal(absent.status, 404)
	const anonymousSubmit = await marketResponse(
		'/v1/notifications',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: notificationBody,
		},
		null,
	)
	assert.equal(anonymousSubmit.status, 401)
	const anonymousReceipt = await marketResponse(`/v1/notifications/${receipt.id}`, {}, null)
	assert.equal(anonymousReceipt.status, 404)
	passed(
		'Built and published 0.1.0 to the real private PNPR source; authenticated notification is durable and deduplicated',
	)
	{
		using processing = admin()
		const result = await processing.processNotifications()
		assert.ok(result.processed >= 1)
	}
	const failed = await marketJson<Receipt>(
		`/v1/notifications/${receipt.id}`,
		undefined,
		session.notificationToken,
	)
	assert.equal(failed.status, 'failed')
	assert.equal(failed.code, 'provenance-runtime-unsupported')
	{
		using retry = admin()
		const result = await retry.retryNotification(receipt.id)
		assert.equal(result.status, 'unavailable')
	}
	{
		using inbox = admin()
		const result = await inbox.listNotifications({
			...identity,
			status: 'failed',
			code: 'provenance-runtime-unsupported',
			limit: 1,
		})
		assert.equal(result.notifications[0]?.id, receipt.id)
		assert.equal(result.notifications[0]?.retry, 'provenance-runtime-unsupported')
		assert.equal('leaseToken' in result.notifications[0], false)
	}
	{
		using details = admin()
		const result: NotificationDetail | null = await details.getNotification(receipt.id)
		assert.ok(result?.diagnostic)
		assert.equal(result.retry, 'provenance-runtime-unsupported')
	}
	passed(
		'The filtered admin inbox explains the provenance failure and retry decision without leaking internal leases',
	)
	{
		using indexing = admin()
		const result = await indexing.refresh({ ...identity, version: '0.1.0' })
		assert.equal(result.status, 'indexed', JSON.stringify(result))
	}
	const first = await marketJson<Release>(packageUrl('/releases/0.1.0'))
	assert.equal(first.registry, session.registry)
	assert.equal(new URL(first.tarball).origin, new URL(session.registry).origin)
	const npmResponse = await fetch(
		new URL(`${encodeURIComponent(name)}/0.1.0`, session.registryUrl),
		{
			headers: { Authorization: `Bearer ${session.registryToken}` },
			signal: AbortSignal.timeout(30_000),
		},
	)
	assert.equal(npmResponse.status, 200)
	assert.equal(
		first.integrity,
		((await npmResponse.json()) as { dist: { integrity: string } }).dist.integrity,
	)
	const retained = await marketJson<Receipt>(`/v1/notifications/${receipt.id}`)
	assert.equal(retained.status, 'failed')
	const anonymousRelease = await marketResponse(packageUrl('/releases/0.1.0'), {}, null)
	assert.equal(anonymousRelease.status, 404)
	const notificationCatalog = await marketResponse(packageUrl(), {}, session.notificationToken)
	assert.equal(notificationCatalog.status, 401)
	const anonymousCatalog = await marketJson<PackagePage>(
		`/v1/packages?${new URLSearchParams({ registry: session.registry })}`,
		undefined,
		null,
	)
	assert.equal(anonymousCatalog.packages.length, 0)
	passed(
		'Manual refresh verified the native private tarball without rewriting its origin; anonymous catalog and receipt reads disclose no private data',
	)
	await run('npm', ['version', '0.2.0', '--no-git-tag-version', '--ignore-scripts'])
	await writeFile(
		resolve(pluginRoot, 'src/hello.ts'),
		pluginSource('Hello from the second release'),
	)
	await run(process.execPath, [cli, 'build'])
	await run(process.execPath, [cli, 'publish', '--webhook', '--market-url', session.marketUrl])
	{
		using observing = admin()
		const result = await observing.refresh({ ...identity, version: '0.1.0' })
		assert.equal(result.status, 'indexed')
	}
	const latest = await marketJson<{ distTags: { latest: string } }>(packageUrl())
	assert.equal(latest.distTags.latest, '0.2.0')
	const unindexed = await marketResponse(packageUrl('/releases/0.2.0'))
	assert.equal(unindexed.status, 404)
	passed(
		'Published 0.2.0; latest records the actual private registry tag before that release is indexed',
	)
	{
		using indexing = admin()
		const result = await indexing.refresh({ ...identity, version: '0.2.0' })
		assert.equal(result.status, 'indexed')
	}
	const second = await marketJson<Release>(packageUrl('/releases/0.2.0'))
	assert.notEqual(second.integrity, first.integrity)
	const tag = `verify-${runId}`
	{
		using curating = admin()
		const result = await curating.setMetadata({
			...identity,
			expectedRevision: 1,
			official: false,
			category: 'development',
			tags: ['market-demo', tag],
		})
		assert.equal(result.status, 'updated')
	}
	const searchPath = `/v1/packages?${new URLSearchParams({ registry: session.registry, query: tag, official: 'false', category: 'development', tag })}`
	const found = await marketJson<PackagePage>(searchPath)
	assert.equal(found.packages.length, 1)
	assert.equal(found.packages[0].name, name)
	assert.equal(found.packages[0].official, false)
	assert.equal(found.packages[0].category, 'development')
	const facetResult = await marketJson<{
		categories: { value: string; count: number }[]
		tags: { value: string; count: number }[]
	}>('/v1/facets')
	assert.ok(facetResult.categories.some((item) => item.value === 'development'))
	assert.equal(facetResult.tags.find((item) => item.value === tag)?.count, 1)
	const anonymousFacets = await marketJson<typeof facetResult>('/v1/facets', undefined, null)
	assert.equal(
		anonymousFacets.tags.some((item) => item.value === tag),
		false,
	)
	const anonymousSearch = await marketJson<PackagePage>(searchPath, undefined, null)
	assert.equal(anonymousSearch.packages.length, 0)
	passed(
		'Market-owned category and tags drive native FTS search and facets; private curation is absent from anonymous results',
	)
	{
		using hiding = admin()
		const result = await hiding.setVisibility({ ...identity, expectedRevision: 2, hidden: true })
		assert.equal(result.status, 'updated')
	}
	const hiddenPackage = await marketResponse(packageUrl())
	const hiddenRelease = await marketResponse(packageUrl('/releases/0.2.0'))
	assert.equal(hiddenPackage.status, 404)
	assert.equal(hiddenRelease.status, 404)
	{
		using stale = admin()
		assert.deepEqual(
			await stale.setVisibility({ ...identity, expectedRevision: 2, hidden: false }),
			{ status: 'conflict', currentRevision: 3 },
		)
	}
	{
		using refreshing = admin()
		const result = await refreshing.refresh({ ...identity, version: '0.2.0' })
		assert.equal(result.status, 'indexed')
	}
	const stillHidden = await marketResponse(packageUrl())
	assert.equal(stillHidden.status, 404)
	{
		using showing = admin()
		const result = await showing.setVisibility({ ...identity, expectedRevision: 3, hidden: false })
		assert.equal(result.status, 'updated')
	}
	{
		using inspecting = admin()
		const result = await inspecting.getPackage(identity)
		assert.equal(result?.revision, 4)
		assert.equal(result?.category, 'development')
		assert.ok(result?.tags.includes(tag))
	}
	passed(
		'Visibility and metadata share revision checks; npm refresh preserves the administrator’s visibility and taxonomy',
	)
	const visible = await marketResponse(packageUrl())
	assert.equal(visible.status, 200)
	assert.equal(visible.headers.get('Cache-Control'), 'no-store')
	const unchanged = await marketResponse(packageUrl(), {
		headers: { 'If-None-Match': visible.headers.get('ETag')! },
	})
	assert.equal(unchanged.status, 304)
	{
		using audit = admin()
		const changes = await audit.recentChanges(identity)
		for (const action of ['metadata', 'hide', 'show'])
			assert.equal(changes.filter((change) => change.action === action).length, 1)
	}
	const unauthorized = await marketResponse('/admin', { method: 'POST', body: '[]' }, null)
	assert.equal(unauthorized.status, 401)
	passed(
		'Authenticated responses are not publicly cached; conditional reads and audit reflect committed operations',
	)
	await writeFile(
		resolve(localRoot, 'last-run.json'),
		`${JSON.stringify({ registry: session.registry, name, pluginRoot, marketUrl: session.publicUrl, receipt: failed, steps }, null, 2)}\n`,
	)
	console.info(`Experience complete. Evidence: ${resolve(localRoot, 'last-run.json')}`)
}
