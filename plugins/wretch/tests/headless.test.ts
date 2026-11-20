import type { Workbench } from '@pluxel/workbench'
import { createServer } from 'node:http'
import * as nativeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { createResolvedHost } from '@pluxel/host/internal'
import { Passthrough } from '@pluxel/core/fs'
import { expect, it } from 'vitest'
import { WretchConfig, WretchPlugin } from '../src/index.ts'

const WorkbenchRef = defineServiceRef<Workbench>()
let origin = ''
let round = 0

@Plugin()
class HeadlessHttpConsumer extends BasePlugin {
	constructor(private readonly http: WretchPlugin) {
		super()
	}
	async init() {
		expect(this.ctx.service(WorkbenchRef)).toBeUndefined()
		await this.http.enableManagedSettings()
		if (round === 0) {
			await this.http.updateManagedSettings({ headers: { 'X-Managed': 'saved' }, timeoutMs: 500 })
		} else {
			expect(this.http.managedSettings).toMatchObject({
				settings: { timeoutMs: 500 },
				hostTimeoutMs: 100,
				effectiveTimeoutMs: 100,
			})
			await expect(
				this.http.updateManagedSettings({ headers: {}, timeoutMs: 501 }),
			).rejects.toThrow('host limit')
		}
		await expect(
			this.http.updateManagedSettings({ headers: { Authorization: 'not-for-storage' } }),
		).rejects.toThrow('secret-bearing')
		const client = this.http.client.headers({
			'X-Managed': 'native',
			Authorization: 'Bearer caller-owned',
		})
		expect(await client.get(origin).text()).toBe('ok')
		await expect(client.get('https://not-allowed.example').text()).rejects.toThrow(/origin/i)
		if (round === 1) {
			await this.http.resetManagedSettings()
			expect(await client.get(origin).text()).toBe('ok')
		}
	}
}

@Plugin()
class SecondManagedConsumer extends BasePlugin {
	constructor(private readonly http: WretchPlugin) {
		super()
	}
	async init() {
		await this.http.enableManagedSettings()
		expect(this.http.managedSettings.settings.headers).toEqual({})
	}
}

it('applies env-bound provider policy and caller saved settings without Workbench', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-wretch-headless-'))
	const requests: { managed?: string; authorization?: string }[] = []
	const server = createServer((request, response) => {
		requests.push({
			managed: request.headers['x-managed'] as string | undefined,
			authorization: request.headers.authorization,
		})
		response.end('ok')
	})
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
	try {
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('No listener')
		origin = `http://127.0.0.1:${address.port}`
		const application = defineHostApplication(() => ({
			plugins: [
				{
					plugin: WretchPlugin,
					config: { timeoutMs: 5_000 },
					envBindings: [
						envBinding({
							config: {
								schema: WretchConfig,
								mapping: { timeoutMs: 'HTTP_TIMEOUT', allowedOrigins: 'HTTP_ORIGINS' },
							},
						}),
					],
				},
				{
					plugin: HeadlessHttpConsumer,
					autoStart: true,
				},
				{
					plugin: SecondManagedConsumer,
					autoStart: true,
				},
			],
			services: [],
			coreConfig: {
				zenfs: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
		}))
		for (round = 0; round < 2; round++) {
			const resolved = await resolveHostApplication(application, {
				root: process.cwd(),
				mode: 'test',
				bindings: {},
				env: { HTTP_TIMEOUT: round === 0 ? '1000' : '100', HTTP_ORIGINS: JSON.stringify([origin]) },
			})
			const host = await createResolvedHost(resolved)
			try {
				await host.start()
				const status = await host.status()
				expect(status.summary.running).toBe(3)
			} finally {
				await host.close()
			}
		}
		expect(requests).toEqual([
			{ managed: 'saved', authorization: 'Bearer caller-owned' },
			{ managed: 'saved', authorization: 'Bearer caller-owned' },
			{ managed: 'native', authorization: 'Bearer caller-owned' },
		])
	} finally {
		try {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		} finally {
			await rm(prefix, { recursive: true, force: true })
		}
	}
})
