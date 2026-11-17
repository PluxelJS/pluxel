import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { BasePlugin, Plugin } from '@pluxel/core'
import type { Store } from 'tinybase'
import { afterEach, describe, expect, it } from 'vitest'
import { Passthrough } from '../src/fs'
import { pluginNodePhysicalKey } from '../src/internal/plugin-address'
import { createCoreTestHost, getCoreTestHostContext } from '../src/internal-test'
import { requireTinyBaseHost } from '../src/internal/storage'
import type { StoreWriter } from '../src/tinybase/writer'

@Plugin()
class RecoverOwner extends BasePlugin {
	readonly state = this.ctx.tinybase
	store!: Store
	protected override async init(): Promise<void> {
		this.store = await this.state.open()
	}
}

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function backing() {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-recovery-'))
	directories.push(prefix)
	let beforeWrite: (() => Promise<void>) | undefined
	let writes = 0
	const native = {
		...nativeFs,
		promises: {
			...nativeFs.promises,
			async rename(...args: Parameters<typeof nativeFs.promises.rename>) {
				if (String(args[1]).includes('/tinybase/nodes/')) {
					writes++
					await beforeWrite?.()
				}
				return nativeFs.promises.rename(...args)
			},
		},
	}
	return {
		prefix,
		native,
		file: join(
			prefix,
			'services/tinybase/nodes',
			`${pluginNodePhysicalKey(RecoverOwner.nodeAddress())}.json`,
		),
		intercept: (operation?: () => Promise<void>) => {
			beforeWrite = operation
		},
		writes: () => writes,
	}
}

describe('TinyBase retained writer recovery', () => {
	it('single-flights retry, blocks replacement until confirmation, and prevents retired recovery writes', async () => {
		const disk = await backing()
		await using host = await createCoreTestHost({
			zenfs: { mounts: { '/': { backend: Passthrough, fs: disk.native, prefix: disk.prefix } } },
		})
		const manager = requireTinyBaseHost(getCoreTestHostContext(host))
		const owner = await host.add(RecoverOwner)
		await owner.state.flush()
		const savedWrites = disk.writes()
		disk.intercept(async () => {
			throw new Error('write rejected')
		})
		owner.store.setValue('candidate', 'retained')
		await expect(owner.state.flush()).rejects.toMatchObject({ code: 'SAVE_FAILED' })
		await expect(manager.recover(RecoverOwner.nodeAddress(), 'retry')).rejects.toMatchObject({
			code: 'WRITER_BLOCKED',
		})
		await host.commitExpectFail((change) => change.remove(RecoverOwner))
		expect(host.isRunning(RecoverOwner)).toBe(false)
		await host.commitExpectFail((change) => change.add(RecoverOwner))
		await expect(manager.recover(RecoverOwner.nodeAddress(), 'retry')).rejects.toThrow(
			'write rejected',
		)
		expect(manager.status()).toMatchObject([{ phase: 'faulted', outcome: 'unknown' }])
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		disk.intercept(async () => {
			entered.resolve()
			await release.promise
		})
		const first = manager.recover(RecoverOwner.nodeAddress(), 'retry')
		const second = manager.recover(RecoverOwner.nodeAddress(), 'retry')
		try {
			await entered.promise
			expect(disk.writes()).toBe(savedWrites + 3)
			await expect(manager.recover(RecoverOwner.nodeAddress(), 'discard')).rejects.toMatchObject({
				code: 'WRITER_BLOCKED',
			})
			await host.commitExpectFail((change) => change.add(RecoverOwner))
		} finally {
			release.resolve()
		}
		await Promise.all([first, second])
		expect(manager.status()).toEqual([])
		disk.intercept()
		const replacement = await host.add(RecoverOwner)
		expect(replacement.store.getValue('candidate')).toBe('retained')
		replacement.store.setValue('candidate', 'replacement confirmed')
		await replacement.state.flush()
		const confirmedWrites = disk.writes()
		await expect((owner.state as StoreWriter).recover('retry')).rejects.toMatchObject({
			code: 'CLOSED',
		})
		expect(disk.writes()).toBe(confirmedWrites)
		expect(JSON.parse(await readFile(disk.file, 'utf8')).content[1].candidate).toBe(
			'replacement confirmed',
		)
	})

	it('discard validates the actual backing and releases ownership without saving the failed candidate', async () => {
		const disk = await backing()
		await using host = await createCoreTestHost({
			zenfs: { mounts: { '/': { backend: Passthrough, fs: disk.native, prefix: disk.prefix } } },
		})
		const manager = requireTinyBaseHost(getCoreTestHostContext(host))
		const owner = await host.add(RecoverOwner)
		owner.store.setValue('value', 'confirmed')
		await owner.state.flush()
		const confirmed = await readFile(disk.file, 'utf8')
		disk.intercept(async () => {
			throw new Error('write rejected')
		})
		owner.store.setValue('value', 'unconfirmed')
		await expect(owner.state.flush()).rejects.toMatchObject({ code: 'SAVE_FAILED' })
		await host.commitExpectFail((change) => change.remove(RecoverOwner))
		const failedWrites = disk.writes()
		await writeFile(disk.file, '{broken')
		await expect(manager.recover(RecoverOwner.nodeAddress(), 'discard')).rejects.toThrow(/JSON/)
		await host.commitExpectFail((change) => change.add(RecoverOwner))
		expect(await readFile(disk.file, 'utf8')).toBe('{broken')
		await writeFile(disk.file, confirmed)
		await manager.recover(RecoverOwner.nodeAddress(), 'discard')
		expect(disk.writes()).toBe(failedWrites)
		disk.intercept()
		const replacement = await host.add(RecoverOwner)
		expect(replacement.store.getValue('value')).toBe('confirmed')
		await replacement.state.flush()
	})

	it.each(['snapshot', 'transaction'] as const)(
		'drains a previous save before reporting a %s fault and closing the Host',
		async (fault) => {
			const disk = await backing()
			const host = await createCoreTestHost({
				zenfs: {
					mounts: { '/': { backend: Passthrough, fs: disk.native, prefix: disk.prefix } },
				},
				tinybase: { maxSnapshotBytes: 1024 },
			})
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			let disposal: Promise<void> | undefined
			try {
				const owner = await host.add(RecoverOwner)
				await owner.state.flush()
				const savedWrites = disk.writes()
				disk.intercept(async () => {
					entered.resolve()
					await release.promise
				})
				owner.store.setValue('progress', 'in flight')
				await entered.promise
				if (fault === 'snapshot') owner.store.setValue('oversized', 'x'.repeat(2048))
				else owner.store.startTransaction().setValue('partial', true)
				await expect(owner.state.flush()).rejects.toMatchObject({
					code: fault === 'snapshot' ? 'BUDGET_EXCEEDED' : 'TRANSACTION_ACTIVE',
				})
				let settled = false
				disposal = host.dispose()
				void disposal.then(
					(): undefined => {
						settled = true
						return undefined
					},
					(): undefined => {
						settled = true
						return undefined
					},
				)
				await setImmediate()
				expect(settled).toBe(false)
				expect(disk.writes()).toBe(savedWrites + 1)
				release.resolve()
				await expect(disposal).rejects.toThrow(/disposal failed/)
				expect(disk.writes()).toBe(savedWrites + 1)
				const content = JSON.parse(await readFile(disk.file, 'utf8')).content
				expect(content[1]).toEqual({ progress: 'in flight' })
			} finally {
				release.resolve()
				await (disposal ?? host.dispose()).catch(() => {})
			}
		},
	)
})
