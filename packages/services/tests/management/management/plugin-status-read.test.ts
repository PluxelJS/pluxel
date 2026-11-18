import {
	parsePluginNodeAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { requirePluginHostCoordinator } from '@pluxel/host/internal'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import type {
	PluginStatusQueryResult,
	PluginStatusSnapshot,
} from '../../../src/management/web/protocol.ts'

@Plugin({ displayName: 'Shared', forkable: true })
class StatusProvider extends BasePlugin {
	readonly config = this.configs.use(v.object({ value: v.optional(v.string(), 'initial') }))
}

@Plugin({ displayName: 'Shared' })
class StatusCollision extends BasePlugin {}

function statusValue(result: PluginStatusQueryResult): PluginStatusSnapshot {
	if (!result.ok || !result.value) throw new Error('Expected a known Plugin status')
	return result.value
}

describe('Management exact Plugin status', () => {
	it.each([8, 1_000, 10_000])(
		'reuses the display directory across exact DTO reads with %i stopped forks',
		async (forkCount) => {
			const definition = StatusProvider.address()
			const forks: PluginForkNodeAddress[] = Array.from({ length: forkCount }, (_, index) => ({
				definition,
				variant: 'fork',
				forkId: `stopped-${index}`,
			}))
			await using host = await createServiceInternalTestHarness({
				services: [],
				workbench: false,
				pluginNodes: [
					{ definition, forks: Object.fromEntries(forks.map(({ forkId }) => [forkId, {}])) },
				],
			})
			host.add(StatusProvider)
			await host.commit()
			const target = new RuntimeManagementTargetImpl(host.ctx)
			const view = await requirePluginHostCoordinator(host.ctx).readCommitted((value) => value)
			const sessionEntries = vi.spyOn(view.sessionIntents, 'values')
			const desiredEntries = vi.spyOn(view.desiredControl, 'values')
			try {
				const address = forks.at(-1)!
				const cold = statusValue(await target.pluginStatusDto(address))
				expect(cold).toMatchObject({
					address,
					lifecycleState: 'stopped',
					availability: 'available',
				})
				expect(sessionEntries).toHaveBeenCalledTimes(1)
				expect(desiredEntries).toHaveBeenCalledTimes(1)
				sessionEntries.mockClear()
				desiredEntries.mockClear()
				for (let index = 0; index < 20; index++) {
					expect(statusValue(await target.pluginStatusDto(address))).toEqual(cold)
				}
				expect(sessionEntries).not.toHaveBeenCalled()
				expect(desiredEntries).not.toHaveBeenCalled()
			} finally {
				sessionEntries.mockRestore()
				desiredEntries.mockRestore()
			}
		},
	)

	it('invalidates the directory when a fork is added or removed', async () => {
		await using host = await createServiceInternalTestHarness({ services: [], workbench: false })
		host.add(StatusProvider)
		await host.commit()
		const target = new RuntimeManagementTargetImpl(host.ctx)
		const address = parsePluginNodeAddress(StatusProvider.nodeAddress())
		const fork = parsePluginNodeAddress(StatusProvider.nodeAddress('east'))
		expect(statusValue(await target.pluginStatusDto(address)).label.text).toBe('Shared')
		expect(await target.ensurePluginForkDto({ fork })).toMatchObject({ ok: true })
		expect(statusValue(await target.pluginStatusDto(fork))).toMatchObject({
			address: fork,
			label: { text: 'Shared / east' },
			availability: 'available',
		})
		expect(await target.removePluginForkDto(fork)).toMatchObject({ ok: true })
		expect(await target.pluginStatusDto(fork)).toEqual({ ok: true, value: null })
		expect(statusValue(await target.pluginStatusDto(address)).label.text).toBe('Shared')
	})

	it('updates collision labels and replacement display names from the new catalog', async () => {
		await using host = await createServiceInternalTestHarness({ services: [], workbench: false })
		host.add(StatusProvider)
		await host.commit()
		const target = new RuntimeManagementTargetImpl(host.ctx)
		const address = parsePluginNodeAddress(StatusProvider.nodeAddress())
		const other = parsePluginNodeAddress(StatusCollision.nodeAddress())
		expect(statusValue(await target.pluginStatusDto(address)).label.text).toBe('Shared')
		host.add(StatusCollision)
		await host.commit()
		expect(statusValue(await target.pluginStatusDto(address)).label.qualifier).toBeDefined()
		expect(statusValue(await target.pluginStatusDto(other)).label.qualifier).toBeDefined()
		const Replacement = lowerTestReplacement(StatusProvider, class extends StatusProvider {}, {
			plugin: { displayName: 'Renamed', forkable: true },
		})
		host.replace(StatusProvider, Replacement)
		await host.commit()
		expect(statusValue(await target.pluginStatusDto(address))).toMatchObject({
			displayName: 'Renamed',
			label: { title: 'Renamed', text: 'Renamed' },
		})
		expect(statusValue(await target.pluginStatusDto(other)).label.text).toBe('Shared')
		host.remove(StatusCollision)
		await host.commit()
		expect(await target.pluginStatusDto(other)).toEqual({ ok: true, value: null })
	})

	it('observes session-only inventory and current Core membership after lifecycle operations', async () => {
		await using host = await createServiceInternalTestHarness({ services: [], workbench: false })
		host.add(StatusProvider)
		await host.commit()
		const target = new RuntimeManagementTargetImpl(host.ctx)
		const address = parsePluginNodeAddress(StatusProvider.nodeAddress())
		const unavailable: PluginNodeAddress = {
			definition: {
				entry: { kind: 'package-root', packageName: '@fixture/session-only' },
				exportName: 'Shared',
			},
			variant: 'default',
		}
		const coordinator = requirePluginHostCoordinator(host.ctx)
		expect(statusValue(await target.pluginStatusDto(address)).label.text).toBe('Shared')
		await coordinator.update({ sessionPatch: [{ address: unavailable, intent: 'stop' }] })
		expect(statusValue(await target.pluginStatusDto(address)).label.qualifier).toBeDefined()
		expect(statusValue(await target.pluginStatusDto(unavailable))).toMatchObject({
			availability: 'unavailable',
			sessionIntent: 'stop',
			label: { title: 'Shared' },
		})
		await coordinator.update({ sessionPatch: [{ address: unavailable, intent: 'inherit' }] })
		expect(statusValue(await target.pluginStatusDto(address)).label.text).toBe('Shared')
		expect(await target.pluginStatusDto(unavailable)).toEqual({ ok: true, value: null })
		expect(
			await target.applyPluginLifecycleCommandsDto([{ address, command: 'start' }]),
		).toMatchObject({ ok: true })
		const running = statusValue(await target.pluginStatusDto(address))
		expect(running.lifecycleState).toBe('running')
		expect(
			await target.applyPluginLifecycleCommandsDto([{ address, command: 'restart' }]),
		).toMatchObject({ ok: true })
		expect(statusValue(await target.pluginStatusDto(address)).label).toBe(running.label)
		expect(
			await target.applyPluginLifecycleCommandsDto([{ address, command: 'stop' }]),
		).toMatchObject({ ok: true })
		expect(statusValue(await target.pluginStatusDto(address))).toMatchObject({
			label: { text: 'Shared' },
			lifecycleState: 'stopped',
		})
	})

	it('reuses display labels across pure queries and configuration edits', async () => {
		await using host = await createServiceInternalTestHarness({ services: [], workbench: false })
		host.add(StatusProvider)
		await host.commit()
		const target = new RuntimeManagementTargetImpl(host.ctx)
		const address = parsePluginNodeAddress(StatusProvider.nodeAddress())
		const before = statusValue(await target.pluginStatusDto(address))
		expect(statusValue(await target.pluginStatusDto(address)).label).toBe(before.label)
		expect(await target.patchPluginConfigDto(address, { set: { value: 'edited' } })).toMatchObject({
			ok: true,
		})
		expect(statusValue(await target.pluginStatusDto(address)).label).toBe(before.label)
	})
})
