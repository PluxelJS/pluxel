import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import type { PluginDefinitionAddress } from '@pluxel/core'
import { controlSha256, encodeControlData } from '@pluxel/core/internal/control-manifest'
import { packageControlFiles } from './fixtures/package-control.ts'
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

it('reads every declared managed root definition from the installed bytes without evaluating modules', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-discovery-'))
	try {
		const manifest = {
			name: 'orders',
			peerDependencies: { '@pluxel/core': '*' },
			exports: { '.': './entry.mjs', './tools': './tools.mjs' },
		}
		await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
		await writeFile(join(root, 'entry.mjs'), "throw new Error('Plugin must not run during checks')")
		await expect(checkInstalledPlugin(root, 'orders')).resolves.toBeUndefined()
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ ...manifest, pluxel: { control: './manifest.json' } }),
		)
		const entry = { kind: 'package-root', packageName: 'orders' } as const
		const roots = [
			{ entry, exportName: 'Orders' },
			{ entry, exportName: 'Tracking' },
		]
		const tools: PluginDefinitionAddress = {
			entry: { kind: 'package-subpath', packageName: 'orders', subpath: './tools' },
			exportName: 'Tools',
		}
		const files = await packageControlFiles([...roots, tools])
		for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
		await expect(checkInstalledPlugin(root, 'orders')).resolves.toEqual(
			roots.map((address) => ({ address })),
		)
		const facts = { requires: [tools], optional: [], forkable: true } as const
		const withDependencies = await packageControlFiles([...roots, tools], { Orders: facts })
		for (const [name, content] of Object.entries(withDependencies))
			await writeFile(join(root, name), content)
		await expect(checkInstalledPlugin(root, 'orders')).resolves.toEqual([
			{ address: roots[0], dependencies: facts },
			{ address: roots[1] },
		])
		await writeFile(join(root, 'dependencies.json'), '{}')
		await expect(checkInstalledPlugin(root, 'orders')).rejects.toThrow(
			'differ from the control manifest',
		)

		// Even a publisher-supplied digest of the actual bytes cannot make malformed UTF-8 a declaration.
		const corrupt = Buffer.from(withDependencies['dependencies.json']!)
		corrupt[corrupt.indexOf('Tools')] = 0xff
		const { snapshot: _snapshot, ...unsigned } = JSON.parse(withDependencies['manifest.json']!)
		const depFile = unsigned.files.find(
			(item: { path: string }) => item.path === 'dependencies.json',
		)
		depFile.sha256 = await controlSha256(corrupt)
		const snapshot = 'sha256:' + (await controlSha256(encodeControlData(unsigned)))
		await writeFile(join(root, 'manifest.json'), encodeControlData({ ...unsigned, snapshot }))
		await writeFile(join(root, 'dependencies.json'), corrupt)
		await expect(checkInstalledPlugin(root, 'orders')).rejects.toThrow(/utf-8/i)

		const altered = JSON.parse(files['manifest.json']!)
		altered.definitions.shift()
		await writeFile(join(root, 'manifest.json'), JSON.stringify(altered))
		await expect(checkInstalledPlugin(root, 'orders')).rejects.toThrow('snapshot mismatch')
		const toolsOnly = await packageControlFiles([tools])
		await writeFile(join(root, 'manifest.json'), toolsOnly['manifest.json']!)
		await expect(checkInstalledPlugin(root, 'orders')).rejects.toThrow(
			'no plugin at this package root',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
