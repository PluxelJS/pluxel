import { requireWorkbench } from '@pluxel/runtime/internal'
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { BasePlugin, Plugin, withRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import type { WorkbenchPrincipal } from '@pluxel/runtime/workbench'
import type { WorkbenchContentObserver } from '@pluxel/runtime/workbench/client'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import { describe, expect, it, vi } from 'vitest'
import { S3Plugin } from '../src/index.ts'

const REFERENCE = Object.freeze({
	type: 'vault' as const,
	namespace: 'storage-workbench-test',
	key: 'assets.s3',
})
const RECOVERY = Object.freeze({ provider: 'local', subject: 'local' })
const ADMIN = Object.freeze({ provider: '@pluxel/auth', subject: 'local:admin' })

@Plugin()
class VaultSeeder extends BasePlugin {}

async function startVaultS3(host: RuntimeHost): Promise<void> {
	host.add(VaultSeeder)
	host.start(VaultSeeder)
	await host.commit()
	await host
		.require(VaultSeeder)
		.ctx.vault!.kv({ namespace: REFERENCE.namespace })
		.set(REFERENCE.key, {
			accessKeyId: 'old-access-key',
			secretAccessKey: 'old-secret-key',
		})
	host.add(S3Plugin)
	host.cfg(S3Plugin).set({
		buckets: [
			{
				id: 'assets',
				backend: {
					type: 'remote',
					endpoint: 'https://bucket.s3.example.com',
					region: 'auto',
					credentials: REFERENCE,
					requestSizeInBytes: 8 * 1024 * 1024,
					requestAbortTimeout: 30_000,
					minPartSize: 8 * 1024 * 1024,
				},
			},
		],
	})
	host.start(S3Plugin)
	await host.commit()
}

async function openCredentials(host: RuntimeHost, principal: WorkbenchPrincipal) {
	const backend = requireWorkbench(host.ctx)
	const target = pluginNodeAddressOf(S3Plugin)
	const layout = backend.registry.getLayout(target)
	const entry = layout.entries.find(
		(candidate) =>
			candidate.descriptor.kind === 'content' && candidate.descriptor.key === 'buckets',
	)
	if (!entry) throw new Error('S3Plugin published no bucket Content')
	const session = backend.createSession(principal, () => {})
	const opened = await session.target.openEntry({
		layoutRevision: layout.revision,
		target,
		descriptor: entry.descriptor,
		location: '/storage/s3',
	})
	if (!opened.ok || opened.value.kind !== 'content' || opened.value.mode !== 'interactive') {
		session.dispose()
		throw new Error('S3 credential Content failed to open')
	}
	return Object.freeze({ opened: opened.value, session })
}

function contentObserver(
	update: WorkbenchContentObserver = () => undefined,
): RpcStub<WorkbenchContentObserver> {
	const observer = Object.assign(
		(outcome: Parameters<WorkbenchContentObserver>[0]) =>
			Object.assign(Promise.resolve(update(outcome)), {
				[Symbol.dispose]: (): void => undefined,
			}),
		{
			dup: () => observer,
			[Symbol.dispose]: (): void => undefined,
		},
	) as unknown as RpcStub<WorkbenchContentObserver>
	return observer
}

describe('S3 Workbench credential rotation', () => {
	it('uses password fields and never echoes replacement credentials', async () => {
		await withRuntimeHost(
			async (host) => {
				await startVaultS3(host)
				const { opened, session } = await openCredentials(host, ADMIN)
				const second = await openCredentials(host, ADMIN)
				const secondUpdates = vi.fn()
				await expect(opened.root.subscribe(contentObserver())).resolves.toMatchObject({
					ok: true,
					data: {
						status: {
							buckets: [
								{
									id: 'assets',
									backend: 'remote-vault',
									credentialRotation: 'available',
								},
							],
						},
					},
				})
				await second.opened.root.subscribe(contentObserver(secondUpdates))
				const action = opened.presentation.slots.find((slot) => slot.kind === 'action')
				expect(action).toMatchObject({
					kind: 'action',
					key: 'rotate',
					input: 'dialog',
					confirm: expect.stringContaining('Vault record'),
				})
				if (!action || action.kind !== 'action' || action.input === 'none') {
					throw new Error('S3 credential action has no form')
				}
				expect(
					action.fields.map((field) =>
						field.kind === 'string'
							? { name: field.name, control: field.control }
							: { name: field.name, control: undefined },
					),
				).toEqual([
					{ name: 'bucketId', control: 'text' },
					{ name: 'accessKeyId', control: 'password' },
					{ name: 'secretAccessKey', control: 'password' },
				])

				const replacement = {
					bucketId: 'assets',
					accessKeyId: 'replacement-access-key',
					secretAccessKey: 'replacement-secret-key',
				}
				const result = await opened.root.run('rotate', replacement)
				expect(result).toMatchObject({
					action: { ok: true, message: expect.stringContaining('Restart') },
					data: {
						ok: true,
						data: {
							status: {
								buckets: [
									{
										id: 'assets',
										backend: 'remote-vault',
										credentialRotation: 'restart-required',
									},
								],
							},
						},
					},
				})
				const serializedResult = JSON.stringify(result)
				expect(serializedResult).not.toContain(replacement.accessKeyId)
				expect(serializedResult).not.toContain(replacement.secretAccessKey)
				await expect(
					host
						.require(VaultSeeder)
						.ctx.vault!.kv({ namespace: REFERENCE.namespace })
						.get(REFERENCE.key),
				).resolves.toEqual({
					accessKeyId: replacement.accessKeyId,
					secretAccessKey: replacement.secretAccessKey,
				})
				await vi.waitFor(() =>
					expect(secondUpdates).toHaveBeenCalledWith(
						expect.objectContaining({
							ok: true,
							data: {
								status: {
									buckets: [
										{
											id: 'assets',
											backend: 'remote-vault',
											credentialRotation: 'restart-required',
										},
									],
								},
							},
						}),
					),
				)
				second.session.dispose()
				await opened.root.run('rotate', replacement)
				await Promise.resolve()
				expect(secondUpdates).toHaveBeenCalledTimes(1)
				session.dispose()
			},
			{ workbench: { enabled: true }, vault: {} },
		)
	})

	it('denies the loopback recovery principal and stops accepting calls with the generation', async () => {
		await withRuntimeHost(
			async (host) => {
				await startVaultS3(host)
				const { opened, session } = await openCredentials(host, RECOVERY)
				await opened.root.subscribe(contentObserver())
				const replacement = {
					bucketId: 'assets',
					accessKeyId: 'forbidden-access-key',
					secretAccessKey: 'forbidden-secret-key',
				}
				await expect(opened.root.run('rotate', replacement)).resolves.toMatchObject({
					action: { ok: false, code: 'rejected' },
					data: { ok: true },
				})
				await expect(
					host
						.require(VaultSeeder)
						.ctx.vault!.kv({ namespace: REFERENCE.namespace })
						.get(REFERENCE.key),
				).resolves.toEqual({
					accessKeyId: 'old-access-key',
					secretAccessKey: 'old-secret-key',
				})

				host.stop(S3Plugin)
				await host.commit()
				await expect(opened.root.run('rotate', replacement)).resolves.toMatchObject({
					action: { ok: false, code: 'invalid_input' },
				})
				session.dispose()
			},
			{ workbench: { enabled: true }, vault: {} },
		)
	})

	it('keeps credential Content topology fixed and rejects local or anonymous backends', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(S3Plugin)
				host.start(S3Plugin)
				await host.commit()
				const { opened, session } = await openCredentials(host, ADMIN)
				await expect(opened.root.subscribe(contentObserver())).resolves.toMatchObject({
					data: {
						status: {
							buckets: [
								{
									id: 'default',
									backend: 'local',
									credentialRotation: 'not-applicable',
								},
							],
						},
					},
				})
				await expect(
					opened.root.run('rotate', {
						bucketId: 'default',
						accessKeyId: 'unused-access-key',
						secretAccessKey: 'unused-secret-key',
					}),
				).resolves.toMatchObject({ action: { ok: false, code: 'rejected' }, data: { ok: true } })
				session.dispose()
			},
			{ workbench: { enabled: true } },
		)

		await withRuntimeHost(
			async (host) => {
				host.add(S3Plugin)
				host.cfg(S3Plugin).set({
					buckets: [
						{
							id: 'public',
							backend: {
								type: 'remote',
								endpoint: 'https://bucket.s3.example.com',
								region: 'auto',
								credentials: { type: 'anonymous' },
								requestSizeInBytes: 8 * 1024 * 1024,
								requestAbortTimeout: 30_000,
								minPartSize: 8 * 1024 * 1024,
							},
						},
					],
				})
				host.start(S3Plugin)
				await host.commit()
				const { opened, session } = await openCredentials(host, ADMIN)
				await expect(opened.root.subscribe(contentObserver())).resolves.toMatchObject({
					data: {
						status: {
							buckets: [
								{
									id: 'public',
									backend: 'remote-anonymous',
									credentialRotation: 'not-applicable',
								},
							],
						},
					},
				})
				await expect(
					opened.root.run('rotate', {
						bucketId: 'public',
						accessKeyId: 'unused-access-key',
						secretAccessKey: 'unused-secret-key',
					}),
				).resolves.toMatchObject({ action: { ok: false, code: 'rejected' }, data: { ok: true } })
				session.dispose()
			},
			{ workbench: { enabled: true } },
		)
	})
})
