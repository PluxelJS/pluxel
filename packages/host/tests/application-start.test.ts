import { BasePlugin, Plugin } from '@pluxel/core'
import { describe, expect, it, vi } from 'vitest'
import {
	createHost,
	defineHostApplication,
	HostApplicationStartupError,
	resolveHostApplication,
} from '../src/index'
import { startHostApplication } from '../src/internal'

@Plugin()
class Healthy extends BasePlugin {}

@Plugin()
class Failing extends BasePlugin {
	protected override init(): void {
		throw new Error('query capability unavailable')
	}
}

const startup = { root: process.cwd(), mode: 'production' as const, env: {}, bindings: {} }

describe('production application startup', () => {
	it('rejects unmet startup intent before launch and closes prepared resources', async () => {
		const close = vi.fn()
		const launch = vi.fn()
		const application = await resolveHostApplication(
			defineHostApplication(() => ({
				plugins: [Healthy, Failing],
				policy: { autoStart: [Healthy, Failing] },
				prepare({ host }) {
					host.ctx.effects.defer(close)
				},
				launch,
			})),
			startup,
		)
		const host = await createHost({ plugins: application.plugins, policy: application.policy })
		const failure = await startHostApplication(application, host).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(HostApplicationStartupError)
		expect(failure).toMatchObject({
			code: 'startup_rejected',
			report: { core: { status: 'committed' } },
		})
		expect((failure as Error).message).toContain('query capability unavailable')
		expect(launch).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
		expect(() => host.start()).toThrow('host is closed')
		await host.close()
		expect(close).toHaveBeenCalledOnce()
	})

	it('allows an explicit application decision to accept partial availability', async () => {
		const order: string[] = []
		const application = await resolveHostApplication(
			defineHostApplication(() => ({
				plugins: [Healthy, Failing],
				policy: { autoStart: [Healthy, Failing] },
				prepare({ host }) {
					order.push('prepare')
					host.ctx.effects.defer(() => {
						order.push('close')
					})
				},
				async acceptStartup({ status, report }) {
					order.push('accept')
					expect(report.core.status).toBe('committed')
					return status.statuses.some(
						(node) => node.rootExportName === 'Healthy' && node.lifecycleState === 'running',
					)
				},
				async launch({ host }) {
					order.push('launch')
					const status = await host.status()
					expect(status.summary.running).toBe(1)
				},
			})),
			startup,
		)
		await using host = await createHost({
			plugins: application.plugins,
			policy: application.policy,
		})
		await startHostApplication(application, host)
		expect(order).toEqual(['prepare', 'accept', 'launch'])
		await host.close()
		expect(order).toEqual(['prepare', 'accept', 'launch', 'close'])
	})

	it('does not require inactive catalog entries to run', async () => {
		const launch = vi.fn()
		const application = await resolveHostApplication(
			defineHostApplication(() => ({
				plugins: [Healthy, Failing],
				policy: { autoStart: [Healthy] },
				launch,
			})),
			startup,
		)
		await using host = await createHost({
			plugins: application.plugins,
			policy: application.policy,
		})
		await startHostApplication(application, host)
		expect(launch).toHaveBeenCalledOnce()
		const status = await host.status()
		expect(status.summary.running).toBe(1)
	})

	it('rejects an intended node missing from the catalog', async () => {
		const launch = vi.fn()
		const application = await resolveHostApplication(
			defineHostApplication(() => ({
				plugins: [Healthy],
				policy: { autoStart: [Failing.nodeAddress()] },
				launch,
			})),
			startup,
		)
		const host = await createHost({ plugins: application.plugins, policy: application.policy })
		await expect(startHostApplication(application, host)).rejects.toMatchObject({
			code: 'startup_rejected',
			status: {
				statuses: expect.arrayContaining([
					expect.objectContaining({
						desiredState: 'running',
						availability: 'unavailable',
						lifecycleState: 'stopped',
					}),
				]),
			},
		})
		expect(launch).not.toHaveBeenCalled()
	})

	it('preserves an entry point failure that already includes Host cleanup', async () => {
		const failure = new Error('entry point failed')
		const cleanupFailure = new Error('cleanup failed')
		let aggregate: AggregateError | undefined
		const application = await resolveHostApplication(
			defineHostApplication(() => ({
				plugins: [],
				prepare({ host }) {
					host.ctx.effects.defer(() => {
						throw cleanupFailure
					})
				},
				async launch({ host }) {
					try {
						await host.close()
					} catch (cleanup) {
						aggregate = new AggregateError([failure, cleanup], 'entry and cleanup failed', {
							cause: failure,
						})
						throw aggregate
					}
				},
			})),
			startup,
		)
		const host = await createHost({ plugins: [] })
		const error = await startHostApplication(application, host).catch((cause: unknown) => cause)
		expect(error).toBe(aggregate)
		expect((error as AggregateError).cause).toBe(failure)
	})

	it.each(['prepare', 'acceptStartup', 'launch'] as const)(
		'preserves %s failures and drains every resource',
		async (stage) => {
			const failure = new Error(`${stage} failed`)
			const cleanupFailure = new Error('cleanup failed')
			const closed = vi.fn()
			const fail = () => {
				throw failure
			}
			const application = await resolveHostApplication(
				defineHostApplication(() => ({
					plugins: [],
					prepare({ host }) {
						host.ctx.effects.defer(closed, { phase: 'final' })
						host.ctx.effects.defer(() => {
							throw cleanupFailure
						})
						if (stage === 'prepare') fail()
					},
					acceptStartup: stage === 'acceptStartup' ? fail : undefined,
					launch: stage === 'launch' ? fail : undefined,
				})),
				startup,
			)
			const host = await createHost({ plugins: [] })
			const error = await startHostApplication(application, host).catch((cause: unknown) => cause)
			expect(error).toBeInstanceOf(AggregateError)
			expect((error as AggregateError).cause).toBe(failure)
			const leaves = (value: unknown): unknown[] =>
				value instanceof AggregateError ? value.errors.flatMap(leaves) : [value]
			expect(leaves(error)).toEqual([failure, cleanupFailure])
			expect(closed).toHaveBeenCalledOnce()
		},
	)

	it('rejects an invalid JavaScript decision rather than treating it as acceptance', async () => {
		const launch = vi.fn()
		const application = await resolveHostApplication(
			defineHostApplication(() => ({
				plugins: [],
				acceptStartup: ((): undefined => undefined) as never,
				launch,
			})),
			startup,
		)
		const host = await createHost({ plugins: [] })
		await expect(startHostApplication(application, host)).rejects.toThrow(
			'acceptStartup must return a boolean',
		)
		expect(launch).not.toHaveBeenCalled()
	})
})
