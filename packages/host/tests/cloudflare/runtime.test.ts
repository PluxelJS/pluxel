import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { Miniflare, Response as WorkerResponse } from 'miniflare'
import { build, type Plugin } from 'vite-plus'
import { expect, it } from 'vitest'
import { createWorkspace } from '../support/workspace'

it('runs static Pluxel plugins in real workerd with request-owned state and managed Fetch', async () => {
	await using workspace = await createWorkspace('cloudflare', ['core', 'host'])
	const { root } = workspace
	await writeFile(
		join(root, 'package.json'),
		'{"name":"cloudflare-host-fixture","private":true,"type":"module"}',
	)
	await cp(new URL('./fixtures/', import.meta.url), root, { recursive: true })
	const output = await build({
		configFile: false,
		root,
		logLevel: 'silent',
		oxc: { decorator: { legacy: true } },
		resolve: {
			conditions: ['workerd', 'worker', 'browser', 'module', 'production'],
		},
		plugins: [createPluginSemanticsPlugin({ root }).plugin as unknown as Plugin],
		build: {
			write: false,
			target: 'esnext',
			lib: { entry: join(root, 'entry.ts'), formats: ['es'] },
		},
	})
	const bundle = Array.isArray(output) ? output[0] : output
	if (!bundle || !('output' in bundle)) throw new Error('Expected a Worker bundle')
	const chunks = bundle.output.filter((chunk) => chunk.type === 'chunk')
	const entry = chunks.find((chunk) => chunk.isEntry)
	if (!entry) throw new Error('Expected a Worker entry')
	const modules = Object.fromEntries(
		chunks.map((chunk) => [chunk.fileName, { type: 'esm' as const, contents: chunk.code }]),
	)
	for (const chunk of chunks) {
		expect(
			[...chunk.imports, ...chunk.dynamicImports].filter((id) => !Object.hasOwn(modules, id)),
		).toEqual([])
	}
	expect(
		chunks
			.flatMap((chunk) => Object.keys(chunk.modules))
			.filter((id) => /(?:node:|__vite-browser-external|\/@zenfs(?:\/|\+))/.test(id)),
	).toEqual([])

	const received: { path: string; header: string | null }[] = []
	const worker = new Miniflare({
		host: '127.0.0.1',
		port: 0,
		workers: [
			{
				config: {
					name: 'cloudflare-host-fixture',
					compatibilityDate: '2026-11-03',
					compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
					manifest: { mainModule: entry.fileName, modules },
					env: {
						BACKEND: {
							type: 'fetcher',
							handler(request) {
								const path = new URL(request.url).pathname
								received.push({ path, header: request.headers.get('x-fixture') })
								return new WorkerResponse(`from binding: ${path}`)
							},
						},
					},
				},
			},
		],
	})
	async function fetchReply(id: string) {
		const response = await worker.dispatchFetch(`http://worker.test/${id}`)
		const body = await response.text()
		if (!response.ok) throw new Error(`Worker returned ${response.status}: ${body}`)
		return JSON.parse(body) as unknown
	}
	async function check(id: string) {
		expect(await fetchReply(id)).toEqual({
			value: `from binding: /${id}`,
			ordinal: 1,
			providerLifetime: ['provider started', 'provider closed'],
			consumerLifetime: ['consumer started', 'consumer closed'],
			running: 2,
			nodeGlobals: false,
		})
	}
	try {
		await check('first')
		await Promise.all([check('second'), check('third')])
		expect(await fetchReply('cancelled')).toEqual({ cancelled: true })
		expect(received.map(({ path }) => path).sort()).toEqual(['/first', '/second', '/third'])
		expect(received.every(({ header }) => header === 'managed-fetch')).toBe(true)
	} finally {
		await worker.dispose()
	}
}, 30_000)
