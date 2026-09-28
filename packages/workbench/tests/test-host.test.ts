import { BasePlugin, Plugin } from '@pluxel/core'
import { workbench } from '@pluxel/workbench'
import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { persistence } from '@pluxel/services/persistence'
import { WorkbenchOpenedContentHandle } from '@pluxel/workbench/internal'
import { expect, it, vi } from 'vitest'

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

it('opens a Workbench entry with only HTTP and Persistence as base services', async () => {
	await using host = await createTestHost({
		workbench: true,
		services: [elysia(), persistence({ mode: 'memory' })],
	})
	await host.start(WorkbenchLeaseFixture)
	using opened = await host.workbench.open({
		target: WorkbenchLeaseFixture,
		entry: WorkbenchLeaseDefinition.lease,
		principal: { provider: 'test', subject: 'minimal-workbench-host' },
	})
	expect(opened).toBeDefined()
	expect(() => host.commands.list()).toThrow(/commands/i)
})

it('reports and closes a leaked public Workbench lease during host disposal', async () => {
	const host = await createTestHost({
		workbench: true,
		services: [elysia(), persistence({ mode: 'memory' })],
	})
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
