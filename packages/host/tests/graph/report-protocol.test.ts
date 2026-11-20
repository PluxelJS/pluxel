import { BasePlugin, Plugin, type PluginNodeAddress } from '@pluxel/core'
import { describe, expect, it, vi } from 'vitest'
import { createHost } from '../../src/index'
import { projectPluginApplyReport, type PluginApplyReportSnapshot } from '../../src/apply-report'
import {
	parsePluginApplyReportSnapshot,
	parseHostPersistenceResult,
	pluginApplyReportOutcome,
} from '../../src/protocol'
import { readHostPluginStatus } from '../../src/status'

@Plugin()
class FailingProvider extends BasePlugin {
	override init(): void {
		throw new Error('provider initialization failed')
	}
}

@Plugin()
class BlockedConsumer extends BasePlugin {
	constructor(readonly provider: FailingProvider) {
		super()
	}
}

@Plugin()
class FailingDrain extends BasePlugin {
	override init() {
		return () => {
			throw new Error('provider drain failed')
		}
	}
}

const address: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/report' },
		exportName: 'Provider',
	},
	variant: 'default',
}

const unchanged: PluginApplyReportSnapshot = {
	persistence: { status: 'unchanged' },
	writtenFields: [],
	catalogRevision: 1,
	runtimeStateRevision: 2,
	reconciliation: [],
	core: { status: 'unchanged' },
}

describe('Host report protocol and completion', () => {
	it('roundtrips actual provider failure, blocked consumer and drain reports', async () => {
		await using host = await createHost({
			plugins: [
				{
					plugin: FailingProvider,
				},
				{
					plugin: BlockedConsumer,
				},
				{
					plugin: FailingDrain,
				},
			],
			policy: {
				document: false,
			},
			config: {
				document: false,
			},
		})
		const failed = projectPluginApplyReport(
			host.ctx,
			await host.startNode(BlockedConsumer.nodeAddress()),
		)
		const parsed = parsePluginApplyReportSnapshot(
			JSON.parse(JSON.stringify(failed)),
			'response.report',
		)
		expect(parsed).toEqual(failed)
		expect(pluginApplyReportOutcome(parsed)).toMatchObject({
			status: 'lifecycle_failed',
			report: parsed,
		})
		if (parsed.core.status !== 'committed') throw new Error('Expected committed startup report')
		const status = await readHostPluginStatus(host.ctx, FailingProvider.nodeAddress())
		expect(status).toMatchObject({ availability: 'available', lifecycleState: 'stopped' })
		expect(Object.getOwnPropertySymbols(status!.address)).toHaveLength(0)
		expect(parsed.core.summary.lifecycleReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'start-failed',
					message: 'provider initialization failed',
				}),
				expect.objectContaining({
					kind: 'dependency-blocked',
					blockedBy: expect.objectContaining({
						definition: FailingProvider.address(),
						variant: 'default',
					}),
				}),
			]),
		)
		expect(Object.isFrozen(parsed.core.summary.lifecycleReport.issues)).toBe(true)
		await host.startNode(FailingDrain.nodeAddress())
		const drained = projectPluginApplyReport(
			host.ctx,
			await host.stopNode(FailingDrain.nodeAddress()),
		)
		expect(parsePluginApplyReportSnapshot(JSON.parse(JSON.stringify(drained)))).toEqual(drained)
		expect(pluginApplyReportOutcome(drained)).toMatchObject({ status: 'lifecycle_failed' })
		if (drained.core.status !== 'committed') throw new Error('Expected committed drain report')
		expect(drained.core.summary.lifecycleReport.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: 'drain-failed' })]),
		)
	})

	it('keeps persistence uncertainty and all application facts together', () => {
		const report: PluginApplyReportSnapshot = {
			...unchanged,
			persistence: { status: 'unknown' },
			reconciliation: [
				{ kind: 'consumer_unavailable', consumer: address, message: 'consumer unavailable' },
			],
		}
		const outcome = pluginApplyReportOutcome(report)
		expect(outcome).toMatchObject({ status: 'persistence_failed', state: 'unknown' })
		expect(outcome.report).toBe(report)
		expect(outcome.report.reconciliation).toHaveLength(1)
		expect(pluginApplyReportOutcome(unchanged)).toEqual({ status: 'applied', report: unchanged })
		for (const retention of ['session', 'declared-durable', 'unknown'] as const) {
			expect(parseHostPersistenceResult({ status: 'confirmed', retention })).toEqual({
				status: 'confirmed',
				retention,
			})
		}
		expect(() =>
			parseHostPersistenceResult({ status: 'unknown', retention: 'session' }, 'saved'),
		).toThrow(/saved.*retention/)
	})

	it('validates the report and lifecycle consistency at its Host boundary', () => {
		const report: PluginApplyReportSnapshot = {
			...unchanged,
			core: {
				status: 'committed',
				summary: {
					pluginChanges: {
						added: [],
						removed: [],
						replaced: [],
						restarted: [],
						availabilityChanged: [],
					},
					runtimeUpdate: {},
					lifecycleReport: {
						ok: true,
						issues: [{ plugin: address, phase: 'start', kind: 'start-failed', message: 'failed' }],
					},
				},
			},
		}
		expect(() => parsePluginApplyReportSnapshot(report, 'received.report')).toThrow(
			/received.report.*ok is inconsistent/,
		)
		expect(() =>
			parsePluginApplyReportSnapshot({ ...unchanged, writtenFields: ['forks', 'forks'] }),
		).toThrow(/duplicate fields/)
		expect(() => parsePluginApplyReportSnapshot({ ...unchanged, catalogRevision: -1 })).toThrow(
			/catalogRevision/,
		)
		expect(() =>
			parsePluginApplyReportSnapshot({ ...unchanged, core: { status: 'unchanged', summary: {} } }),
		).toThrow(/core.*summary/)
	})

	it('rejects getter-backed report and address fields without invoking them', () => {
		const getter = vi.fn(() => 'default')
		const poisonedAddress = Object.defineProperty({ definition: address.definition }, 'variant', {
			enumerable: true,
			get: getter,
		})
		expect(() =>
			parsePluginApplyReportSnapshot(
				{
					...unchanged,
					reconciliation: [
						{ kind: 'consumer_unavailable', consumer: poisonedAddress, message: '' },
					],
				},
				'wire',
			),
		).toThrow(/wire.*consumer.*data property/)
		const poisonedReport = Object.defineProperty({ ...unchanged }, 'core', {
			enumerable: true,
			get: getter,
		})
		expect(() => parsePluginApplyReportSnapshot(poisonedReport)).toThrow(/core.*data property/)
		expect(getter).not.toHaveBeenCalled()
	})
})
