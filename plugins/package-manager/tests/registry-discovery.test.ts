import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import {
	checkInstalledPlugin,
	configuredRegistry,
	inspectPluginManifest,
	searchRegistry,
} from '../src/registry-discovery.ts'
import type { ResolvedConfig } from '../src/pnpm-engine.ts'

it('checks the production root, host peer range, and subpath-only packages without importing code', () => {
	const peers = { peerDependencies: { '@pluxel/core': '*' } }
	expect(
		inspectPluginManifest({
			...peers,
			exports: { '.': { types: './x.d.ts', '@pluxel/hmr': './src.ts', import: './runtime.mjs' } },
		}),
	).toMatchObject({ ok: true, entry: './runtime.mjs' })
	for (const fields of [
		{},
		{ ...peers, exports: { './plugins': './plugin.mjs' } },
		{ ...peers, exports: { '.': { require: './cjs.cjs' } } },
		{ ...peers, exports: './../outside.js' },
		{ exports: './index.js', peerDependencies: { '@pluxel/core': '<0.1.0' } },
	])
		expect(inspectPluginManifest(fields)).toMatchObject({ ok: false })
})

it('searches a configured scope on the server and returns only public candidate fields', async () => {
	let url = '',
		authorization = ''
	const server = createServer((request, response) => {
		url = request.url!
		authorization = request.headers.authorization!
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				objects: [
					{
						package: {
							name: '@test/orders',
							version: '1.2.0',
							description: 'Orders',
							unwanted: 'secret',
						},
					},
					{ package: { name: '../bad', version: '3' } },
				],
			}),
		)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	try {
		const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/npm'
		const config = {
			noProxy: true,
			registries: [
				{ name: 'default', url: 'https://registry.npmjs.org/' },
				{ name: '@test', url: base + '/', authHeader: 'Bearer fixture' },
			],
		} as ResolvedConfig
		expect(configuredRegistry(config, 'orders').url).toBe('https://registry.npmjs.org')
		expect(
			await searchRegistry(config, '@test orders', false, new AbortController().signal),
		).toEqual({
			registry: base,
			packages: [{ name: '@test/orders', version: '1.2.0', description: 'Orders' }],
		})
		expect(new URL(url, base).pathname).toBe('/npm/-/v1/search')
		expect(new URL(url, base).searchParams.get('text')).toBe('@test orders')
		expect(authorization).toBe('Bearer fixture')
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		)
	}
})

it('verifies a declared root plugin from published files without executing the root module', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-discovery-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'orders',
				peerDependencies: { '@pluxel/core': '*' },
				exports: { '.': './entry.mjs' },
				pluxel: { control: './control.json' },
			}),
		)
		await writeFile(join(root, 'entry.mjs'), "throw new Error('Plugin must not run during checks')")
		async function writeControl(kind: 'package-root' | 'package-subpath') {
			await writeFile(
				join(root, 'control.json'),
				JSON.stringify({
					definitions: [
						{
							definition: {
								entry: {
									kind,
									packageName: 'orders',
									...(kind === 'package-subpath' && { subpath: './tools' }),
								},
								exportName: 'OrdersPlugin',
							},
						},
					],
				}),
			)
		}
		await writeControl('package-root')
		await expect(checkInstalledPlugin(root, 'orders')).resolves.toBeUndefined()
		await writeControl('package-subpath')
		await expect(checkInstalledPlugin(root, 'orders')).rejects.toThrow(
			'no plugin at this package root',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
