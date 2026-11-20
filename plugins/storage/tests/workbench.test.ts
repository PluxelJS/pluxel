import { createTestHost, type TestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { type WorkbenchPrincipal } from '@pluxel/workbench'
import { type WorkbenchContentObserver } from '@pluxel/workbench/client'
import { type RpcStub } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'
import { S3Plugin } from '../src/index.ts'
import { S3Workbench } from '../src/workbench.ts'

const REFERENCE = Object.freeze({
	type: 'vault' as const,
	namespace: 'storage-workbench-test',
	key: 'assets.s3',
})
const RECOVERY = Object.freeze({ provider: 'local', subject: 'local' })
const ADMIN = Object.freeze({ provider: '@pluxel/plugin-auth', subject: 'local:admin' })

async function startVaultS3(host: TestHost<true>): Promise<void> {
	await host.start(S3Plugin.nodeAddress(), {
		initialConfig: {
			buckets: [
				{
					id: 'assets',
					backend: {
						type: 'remote',
						endpoint: 'https://bucket.s3.example.com',
						credentials: { type: 'anonymous' },
					},
				},
			],
		},
	})
	await host
		.require(S3Plugin.nodeAddress())
		.ctx.vault.kv({ namespace: REFERENCE.namespace })
		.set(REFERENCE.key, {
			accessKeyId: 'old-access-key',
			secretAccessKey: 'old-secret-key',
		})
	await host.stop(S3Plugin.nodeAddress())
	await host.config.patch(S3Plugin.nodeAddress(), {
		set: {
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
		},
	})
	await host.start(S3Plugin.nodeAddress())
}

function openCredentials(host: TestHost<true>, principal: WorkbenchPrincipal) {
	return host.workbench.open({
		target: S3Plugin.nodeAddress(),
		entry: S3Workbench.buckets,
		principal,
		location: '/storage/s3',
	})
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
	it('restricts rotation to administrators, sends redacted updates and withdraws the action on stop', async () => {
		await using host = await createTestHost({ workbench: true, services: [elysia()] })
		await startVaultS3(host)
		const vault = host.require(S3Plugin.nodeAddress()).ctx.vault.kv({
			namespace: REFERENCE.namespace,
		})
		const replacement = {
			bucketId: 'assets',
			accessKeyId: 'replacement-access-key',
			secretAccessKey: 'replacement-secret-key',
		}

		using recovery = await openCredentials(host, RECOVERY)
		await recovery.root.subscribeDto(contentObserver())
		await expect(recovery.root.runDto('rotate', replacement)).resolves.toMatchObject({
			action: { ok: false, code: 'rejected' },
			data: { ok: true },
		})
		const original = await vault.get(REFERENCE.key)
		expect(original.value).toEqual({
			accessKeyId: 'old-access-key',
			secretAccessKey: 'old-secret-key',
		})

		using opened = await openCredentials(host, ADMIN)
		using second = await openCredentials(host, ADMIN)
		const status = {
			buckets: [{ id: 'assets', backend: 'remote-vault', credentialRotation: 'available' }],
		}
		await expect(opened.root.subscribeDto(contentObserver())).resolves.toMatchObject({
			ok: true,
			data: { status },
		})
		const secondUpdate = Promise.withResolvers<Parameters<WorkbenchContentObserver>[0]>()
		const secondUpdates = vi.fn(secondUpdate.resolve)
		await second.root.subscribeDto(contentObserver(secondUpdates))

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
		expect(action.fields).toMatchObject([
			{ name: 'bucketId', control: 'text' },
			{ name: 'accessKeyId', control: 'password' },
			{ name: 'secretAccessKey', control: 'password' },
		])

		const result = await opened.root.runDto('rotate', replacement)
		expect(result).toMatchObject({
			action: { ok: true, message: expect.stringContaining('New requests') },
			data: { ok: true, data: { status } },
		})
		const update = await secondUpdate.promise
		expect(update).toMatchObject({ ok: true, data: { status } })
		for (const reply of [result, update]) {
			const serialized = JSON.stringify(reply)
			expect(serialized).not.toContain(replacement.accessKeyId)
			expect(serialized).not.toContain(replacement.secretAccessKey)
		}
		const updated = await vault.get(REFERENCE.key)
		expect(updated.value).toEqual({
			accessKeyId: replacement.accessKeyId,
			secretAccessKey: replacement.secretAccessKey,
		})

		const updatesBeforeDispose = secondUpdates.mock.calls.length
		second[Symbol.dispose]()
		await opened.root.runDto('rotate', {
			...replacement,
			accessKeyId: 'another-access-key',
		})
		expect(secondUpdates).toHaveBeenCalledTimes(updatesBeforeDispose)

		await host.stop(S3Plugin.nodeAddress())
		await expect(recovery.root.runDto('rotate', replacement)).resolves.toMatchObject({
			action: { ok: false, code: 'invalid_input' },
		})
	})

	it('keeps local and anonymous buckets in one Content and rejects rotation for both', async () => {
		await using host = await createTestHost({ workbench: true, services: [elysia()] })
		await host.start(S3Plugin.nodeAddress(), {
			initialConfig: {
				buckets: [
					{ id: 'default', backend: { type: 'local' } },
					{
						id: 'public',
						backend: {
							type: 'remote',
							endpoint: 'https://bucket.s3.example.com',
							credentials: { type: 'anonymous' },
						},
					},
				],
			},
		})
		using opened = await openCredentials(host, ADMIN)
		await expect(opened.root.subscribeDto(contentObserver())).resolves.toMatchObject({
			data: {
				status: {
					buckets: [
						{ id: 'default', backend: 'local', credentialRotation: 'not-applicable' },
						{ id: 'public', backend: 'remote-anonymous', credentialRotation: 'not-applicable' },
					],
				},
			},
		})
		for (const bucketId of ['default', 'public']) {
			await expect(
				opened.root.runDto('rotate', {
					bucketId,
					accessKeyId: 'unused-access-key',
					secretAccessKey: 'unused-secret-key',
				}),
			).resolves.toMatchObject({ action: { ok: false, code: 'rejected' }, data: { ok: true } })
		}
	})
})
