import { createServer } from 'node:http'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { envBinding, defineHostApplication, runHostApplication } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'
import { expect, it } from 'vitest'
import { S3, S3VaultSchema, S3Plugin } from '../src/index.ts'

@Plugin()
class DeploymentWriter extends BasePlugin {
	constructor(private readonly storage: S3) {
		super()
	}
	async init() {
		await this.storage.bucket('test').client.putObject('deployment-check', 'payload')
	}
}

it('signs and completes an S3 write using only env-backed Vault records', async () => {
	const requests: { authorization: string | undefined; url: string | undefined; body: string }[] =
		[]
	const server = createServer(async (request, response) => {
		let body = ''
		for await (const part of request) body += String(part)
		requests.push({ authorization: request.headers.authorization, url: request.url, body })
		response.writeHead(200, { ETag: '"test"' })
		response.end()
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	try {
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Missing test listener')
		const application = defineHostApplication(() => ({
			plugins: [S3Plugin, DeploymentWriter],
			services: [vault({ backend: 'bindings' })],
			state: { initial: { autoStart: [pluginNodeAddressOf(DeploymentWriter)] } },
			configRecords: {
				initial: [
					{
						owner: pluginNodeAddressOf(S3Plugin),
						config: {
							buckets: [
								{
									id: 'test',
									backend: {
										type: 'remote',
										endpoint: `http://127.0.0.1:${address.port}`,
										region: 'auto',
										credentials: { type: 'vault', key: 'primary' },
									},
								},
							],
						},
					},
				],
			},
			envBindings: [
				envBinding(S3Plugin, {
					vault: {
						schema: S3VaultSchema,
						mapping: { primary: { accessKeyId: 'ACCESS_KEY', secretAccessKey: 'SECRET_KEY' } },
					},
				}),
			],
		}))
		const host = await runHostApplication(application, {
			startup: {
				root: process.cwd(),
				mode: 'test',
				bindings: {},
				env: { ACCESS_KEY: 'deployment-access', SECRET_KEY: 'deployment-secret' },
			},
		})
		try {
			const status = await host.status()
			expect(status.summary.running).toBe(2)
			expect(requests).toHaveLength(1)
			expect(requests[0]).toMatchObject({ url: '/deployment-check', body: 'payload' })
			expect(requests[0]?.authorization).toContain('Credential=deployment-access/')
			expect(requests[0]?.authorization).not.toContain('deployment-secret')
		} finally {
			await host.close()
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
	}
})
