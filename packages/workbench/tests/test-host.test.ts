import { type Workbench, workbench } from '@pluxel/workbench'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { WorkbenchOpenedContentHandle } from '@pluxel/workbench/internal'
import { expect, it, vi } from 'vitest'

const WorkbenchRef = defineServiceRef<Workbench>()
const WorkbenchLeaseDefinition = workbench.define(import.meta.url, {
	lease: workbench.content({
		document: './fixtures/test-host-lease.md',
		placement: { kind: 'tab', label: 'Lease' },
	}),
})

@Plugin({ displayName: 'Workbench lease fixture' })
class WorkbenchLeaseFixture extends BasePlugin {
	protected override init(): void {
		this.ctx.service(WorkbenchRef)?.publish(WorkbenchLeaseDefinition)
	}
}

it('tracks Workbench leases with only HTTP installed and reports precisely the leaked lease', async () => {
	const host = await createTestHost({
		workbench: true,
		services: [elysia()],
	})
	let disposalAttempted = false
	try {
		await host.start(WorkbenchLeaseFixture.nodeAddress())
		const entry = {
			target: WorkbenchLeaseFixture.nodeAddress(),
			entry: WorkbenchLeaseDefinition.lease,
			principal: { provider: 'test', subject: 'runtime-test-host' },
		}
		expect(() => host.commands.list()).toThrow(/commands/i)
		{
			using opened = await host.workbench.open(entry)
			expect(opened).toBeDefined()
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
		const opened = await host.workbench.open(entry)

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
		await expect(host.workbench.open(entry)).rejects.toThrow(/closing or closed/i)
	} finally {
		if (!disposalAttempted) await host.dispose().catch((): undefined => undefined)
	}
})
