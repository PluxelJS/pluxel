import { pluginDefinitionAddressOf, type PluginConstructor } from '@pluxel/runtime'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s3Mock = vi.hoisted(() => {
	const clients: Array<Record<string, any>> = []
	const configs: Array<Record<string, any>> = []
	return { clients, configs }
})

vi.mock('s3mini', () => ({
	S3mini: class {
		getObject = vi.fn()
		putObject = vi.fn()

		constructor(config: Record<string, unknown>) {
			s3Mock.configs.push(config)
			s3Mock.clients.push(this)
		}
	},
}))

import { S3, S3CredentialsError, S3NotRunningError, S3Plugin } from '../src/index.ts'

@Plugin()
class S3Consumer extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

@Plugin()
class S3ConsumerA extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

@Plugin()
class S3ConsumerB extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

@Plugin()
class S3VaultSeeder extends BasePlugin {}

function addStarted(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.start(PluginClass)
}

beforeEach(() => {
	s3Mock.clients.length = 0
	s3Mock.configs.length = 0
	vi.unstubAllGlobals()
})

describe('S3Plugin remote backend', () => {
	it('exposes a real anonymous s3mini client from the same configurable provider', async () => {
		await withRemoteS3(async (s3, client, config) => {
			expect(s3.client).toBe(client)
			expect(config).toMatchObject({
				accessKeyId: '',
				secretAccessKey: '',
				endpoint: 'https://bucket.s3.example.com',
				region: 'auto',
				requestSizeInBytes: 4 * 1024 * 1024,
				requestAbortTimeout: 30_000,
				minPartSize: 8 * 1024 * 1024,
			})
			client.putObject.mockResolvedValue(new Response(null, { status: 200 }))
			await s3.client.putObject('native/key', 'body')
			expect(client.putObject).toHaveBeenCalledWith('native/key', 'body')
		})
	})

	it('resolves access keys from a configured Vault reference without another plugin', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [S3VaultSeeder])
				await host.commit()
				await host
					.require(S3VaultSeeder)
					.ctx.vault!.kv({ namespace: 'shared-secrets' })
					.set('assets.s3', {
						accessKeyId: 'access-id',
						secretAccessKey: 'secret-value',
					})

				addStarted(host, [S3Plugin, S3Consumer])
				host.cfg(S3Plugin).set({
					...remoteConfig({
						type: 'vault',
						key: 'assets.s3',
						namespace: 'shared-secrets',
					}),
				})
				await host.commit()
				expect(s3Mock.configs.at(-1)).toMatchObject({
					accessKeyId: 'access-id',
					secretAccessKey: 'secret-value',
				})
			},
			{ vault: {} },
		)
	})

	it('isolates config, clients, and lifecycle across two forks of one provider', async () => {
		await withRuntimeHost(async (host) => {
			host.add([S3Plugin, S3ConsumerA, S3ConsumerB])
			const East = host.fork(S3Plugin, 'east')
			const West = host.fork(S3Plugin, 'west')
			host.cfg(East).set({
				...remoteConfig({ type: 'anonymous' }),
				backend: {
					...remoteConfig({ type: 'anonymous' }).backend,
					endpoint: 'https://east-bucket.s3.example.com',
				},
			})
			host.cfg(West).set({
				...remoteConfig({ type: 'anonymous' }),
				backend: {
					...remoteConfig({ type: 'anonymous' }).backend,
					endpoint: 'https://west-bucket.s3.example.com',
				},
			})
			host.start(East)
			host.start(West)
			host.start(S3ConsumerA)
			host.start(S3ConsumerB)
			host.override(S3ConsumerA, pluginDefinitionAddressOf(S3), East)
			host.override(S3ConsumerB, pluginDefinitionAddressOf(S3), West)

			await host.commit()
			const eastCapability = host.require(S3ConsumerA).s3
			const westCapability = host.require(S3ConsumerB).s3
			const eastClient = eastCapability.client
			const westClient = westCapability.client
			expect(eastClient).not.toBe(westClient)
			expect(s3Mock.configs.map((config) => config.endpoint).sort()).toEqual([
				'https://east-bucket.s3.example.com',
				'https://west-bucket.s3.example.com',
			])
			expect(host.require(East).ctx).not.toBe(host.require(West).ctx)

			host.stop(East)
			await host.commitAllowFail()
			expect(() => eastCapability.client).toThrow('Plugin owner stopped')
			expect(westCapability.client).toBe(westClient)
		})
	})

	it('fails lifecycle when a configured Vault reference is missing', async () => {
		await withRuntimeHost(async (host) => {
			addStarted(host, [S3Plugin, S3Consumer])
			host.cfg(S3Plugin).set({
				...remoteConfig({ type: 'vault', key: 'missing.s3' }),
			})
			const commit = await host.commitAllowFail()
			expect(host.isRunning(S3Plugin)).toBe(false)
			expect(
				commit.lifecycleReport.issues.some(
					(issue) => issue.error?.name === S3CredentialsError.name,
				),
			).toBe(true)
		})
	})

	it('aborts s3mini fetches and revokes the capability when the provider stops', async () => {
		const fetchMock = vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
						once: true,
					})
				}),
		)
		vi.stubGlobal('fetch', fetchMock)

		await withRuntimeHost(async (host) => {
			addStarted(host, [S3Plugin, S3Consumer])
			host.cfg(S3Plugin).set(remoteConfig({ type: 'anonymous' }))
			await host.commit()
			const capability = host.require(S3Consumer).s3
			const client = s3Mock.clients.at(-1)!
			const config = s3Mock.configs.at(-1)!
			client.getObject.mockImplementation(() => config.fetch('https://bucket/key', {}))
			const pending = capability.client.getObject('key')
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

			host.stop(S3Plugin)
			await host.commit()
			await expect(pending).rejects.toBeInstanceOf(S3NotRunningError)
			expect(() => capability.client).toThrow('Plugin owner stopped')
		})
	})
})

type RemoteCredentials = { type: 'anonymous' } | { type: 'vault'; key: string; namespace?: string }

function remoteConfig(credentials: RemoteCredentials) {
	return {
		backend: {
			type: 'remote' as const,
			endpoint: 'https://bucket.s3.example.com',
			region: 'auto',
			credentials,
			requestSizeInBytes: 4 * 1024 * 1024,
			requestAbortTimeout: 30_000,
			minPartSize: 8 * 1024 * 1024,
		},
	}
}

async function withRemoteS3(
	run: (s3: S3, client: Record<string, any>, config: Record<string, any>) => void | Promise<void>,
): Promise<void> {
	await withRuntimeHost(async (host) => {
		addStarted(host, [S3Plugin, S3Consumer])
		host.cfg(S3Plugin).set(remoteConfig({ type: 'anonymous' }))
		await host.commit()
		await run(host.require(S3Consumer).s3, s3Mock.clients.at(-1)!, s3Mock.configs.at(-1)!)
	})
}
