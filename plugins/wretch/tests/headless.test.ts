import { createServer } from 'node:http'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { createMemoryPersistenceBackend, persistence } from '@pluxel/services/persistence'
import { expect, it } from 'vitest'
import { WretchConfig, WretchPlugin } from '../src/index.ts'

let origin = ''
let round = 0

@Plugin()
class StatelessHttpConsumer extends BasePlugin {
	constructor(private readonly http: WretchPlugin) {
		super()
	}
	async init() {
		expect(this.ctx.root.persistence).toBeUndefined()
		expect(this.ctx.workbench).toBeUndefined()
		await expect(this.http.enableManagedSettings()).rejects.toThrow(
			'require the Persistence service',
		)
		await expect(this.http.updateManagedSettings({ headers: {} })).rejects.toThrow(
			'require the Persistence service',
		)
		await expect(this.http.resetManagedSettings()).rejects.toThrow(
			'require the Persistence service',
		)
		expect(() => this.http.managedSettings).toThrow('require the Persistence service')
		expect(await this.http.client.get(origin).text()).toBe('stateless')
		await expect(this.http.client.get('https://not-allowed.example').text()).rejects.toThrow(
			/origin/i,
		)
	}
}

it('runs native HTTP and env policy with services: [] while explicitly rejecting managed storage operations', async () => {
	let requests = 0
	const server = createServer((_request, response) => {
		requests++
		response.end('stateless')
	})
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
	try {
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('No listener')
		origin = `http://127.0.0.1:${address.port}`
		const application = defineHostApplication(() => ({
			plugins: [WretchPlugin, StatelessHttpConsumer],
			services: [],
			state: { initial: { autoStart: [pluginNodeAddressOf(StatelessHttpConsumer)] } },
			envBindings: [
				envBinding(WretchPlugin, {
					config: { schema: WretchConfig, mapping: { allowedOrigins: 'HTTP_ORIGINS' } },
				}),
			],
		}))
		const resolved = await resolveHostApplication(application, {
			root: process.cwd(),
			mode: 'test',
			bindings: {},
			env: { HTTP_ORIGINS: JSON.stringify([origin]) },
		})
		const host = await createHost({
			plugins: resolved.plugins,
			services: resolved.services,
			state: resolved.state,
			config: resolved.config,
			configRecords: resolved.configRecords,
		})
		try {
			await host.start()
			const status = await host.status()
			expect(status.summary.running).toBe(2)
			expect(requests).toBe(1)
		} finally {
			await host.close()
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
	}
})

@Plugin()
class HeadlessHttpConsumer extends BasePlugin {
	constructor(private readonly http: WretchPlugin) {
		super()
	}
	async init() {
		expect(this.ctx.workbench).toBeUndefined()
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
		const memory = createMemoryPersistenceBackend()
		let settingsNamespaces = 0
		const backend = {
			...memory,
			namespace(name: string) {
				if (name === '@pluxel/wretch') settingsNamespaces++
				return memory.namespace(name)
			},
		}
		const application = defineHostApplication(() => ({
			plugins: [WretchPlugin, HeadlessHttpConsumer, SecondManagedConsumer],
			services: [persistence({ mode: 'custom', backend })],
			state: {
				initial: {
					autoStart: [
						pluginNodeAddressOf(HeadlessHttpConsumer),
						pluginNodeAddressOf(SecondManagedConsumer),
					],
				},
			},
			configRecords: {
				initial: [{ owner: pluginNodeAddressOf(WretchPlugin), config: { timeoutMs: 5_000 } }],
			},
			envBindings: [
				envBinding(WretchPlugin, {
					config: {
						schema: WretchConfig,
						mapping: { timeoutMs: 'HTTP_TIMEOUT', allowedOrigins: 'HTTP_ORIGINS' },
					},
				}),
			],
		}))
		for (round = 0; round < 2; round++) {
			const resolved = await resolveHostApplication(application, {
				root: process.cwd(),
				mode: 'test',
				bindings: {},
				env: { HTTP_TIMEOUT: round === 0 ? '1000' : '100', HTTP_ORIGINS: JSON.stringify([origin]) },
			})
			const host = await createHost({
				plugins: resolved.plugins,
				services: resolved.services,
				state: resolved.state,
				config: resolved.config,
				configRecords: resolved.configRecords,
			})
			try {
				await host.start()
				const status = await host.status()
				expect(status.summary.running).toBe(3)
			} finally {
				await host.close()
			}
		}
		expect(settingsNamespaces).toBe(2) // One shared lazy namespace per provider generation.
		expect(requests).toEqual([
			{ managed: 'saved', authorization: 'Bearer caller-owned' },
			{ managed: 'saved', authorization: 'Bearer caller-owned' },
			{ managed: 'native', authorization: 'Bearer caller-owned' },
		])
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
	}
})
