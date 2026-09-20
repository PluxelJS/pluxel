import { BasePlugin, Plugin } from '@pluxel/core/test'
import { workbench } from '@pluxel/workbench'
import { createWorkbenchTestHost } from '@pluxel/services/test'
import { createLocalRpcClient } from '@pluxel/workbench/test'
import { WorkbenchOpenedContentHandle } from '@pluxel/workbench/internal'
import { RpcTarget } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'

const WorkbenchLeaseDefinition = workbench.define({
	lease: workbench.content({
		document: workbench.markdown(import.meta.url, './fixtures/test-host-lease.md'),
		placement: workbench.tab({ label: 'Lease' }),
	}),
})

@Plugin({ displayName: 'Workbench lease fixture' })
class WorkbenchLeaseFixture extends BasePlugin {
	protected override init(): void {
		this.ctx.workbench?.publish(WorkbenchLeaseDefinition)
	}
}

class BorrowedTarget extends RpcTarget {
	readonly dispose = vi.fn()

	echo(value: Readonly<{ nested: { count: number } }>) {
		return value
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}

it('reports and closes a leaked public Workbench lease during host disposal', async () => {
	const host = await createWorkbenchTestHost()
	let disposalAttempted = false
	try {
		await host.start(WorkbenchLeaseFixture)
		const entry = {
			target: WorkbenchLeaseFixture,
			entry: WorkbenchLeaseDefinition.lease,
			principal: { provider: 'test', subject: 'runtime-test-host' },
		}
		const abortedOpen = new AbortController()
		const pending = host.workbench.open({ ...entry, signal: abortedOpen.signal })
		const reason = new Error('test open canceled')
		abortedOpen.abort(reason)
		await expect(pending).rejects.toBe(reason)
		const abortedLease = new AbortController()
		await host.workbench.open({ ...entry, signal: abortedLease.signal })
		abortedLease.abort(reason)
		const failedCleanup = new AbortController()
		const failedLease = await host.workbench.open({ ...entry, signal: failedCleanup.signal })
		const cleanupFailure = new Error('test lease cleanup failed')
		const cleanup = vi
			.spyOn(WorkbenchOpenedContentHandle.prototype, Symbol.dispose)
			.mockImplementationOnce(() => {
				throw cleanupFailure
			})
		try {
			expect(() => failedCleanup.abort(reason)).not.toThrow()
			expect(() => failedLease[Symbol.dispose]()).toThrow(cleanupFailure)
		} finally {
			cleanup.mockRestore()
		}
		// Only this intentionally unclosed lease may appear in the disposal report.
		const opened = await host.workbench.open({
			target: WorkbenchLeaseFixture,
			entry: WorkbenchLeaseDefinition.lease,
			principal: { provider: 'test', subject: 'runtime-test-host' },
		})

		disposalAttempted = true
		const error = await host.dispose().catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(AggregateError)
		expect(error).toMatchObject({
			message: expect.stringContaining('Service test host disposal failed'),
		})
		expect((error as AggregateError).errors).toEqual([
			expect.objectContaining({
				errors: [
					expect.objectContaining({ message: expect.stringContaining('Leaked Workbench entry') }),
				],
			}),
		])

		expect(() => opened[Symbol.dispose]()).not.toThrow()
		await expect(
			host.workbench.open({
				target: WorkbenchLeaseFixture,
				entry: WorkbenchLeaseDefinition.lease,
				principal: { provider: 'test', subject: 'runtime-test-host' },
			}),
		).rejects.toThrow(/closing or closed/i)
	} finally {
		if (!disposalAttempted) await host.dispose().catch((): undefined => undefined)
	}
})

describe('local RPC ownership', () => {
	it('borrows the root target while preserving local membrane copies', async () => {
		const target = new BorrowedTarget()
		const client = createLocalRpcClient(target)
		const input = { nested: { count: 1 } }
		const output = await client.echo(input)
		expect(output).toEqual(input)
		expect(output).not.toBe(input)
		client[Symbol.dispose]()
		expect(target.dispose).not.toHaveBeenCalled()
		target[Symbol.dispose]()
		expect(target.dispose).toHaveBeenCalledOnce()
	})
})
