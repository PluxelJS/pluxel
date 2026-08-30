import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import {
	parseWorkbenchDeclarationIdentity,
	type WorkbenchViewDeclarationIdentity,
} from '@pluxel/core/federation'
import { describe, expect, it, vi } from 'vitest'
import {
	createRemoteValue,
	openWorkbenchView,
	readWorkbenchLayout,
	type WorkbenchLayoutEntry,
	type WorkbenchSessionApi,
} from '@pluxel/runtime/workbench/client'
import type { RpcStub } from '@pluxel/runtime/capnweb'

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/settings' },
	exportName: 'SettingsPlugin',
})
const node = parsePluginNodeAddress({ definition, variant: 'default' })
const descriptor = parseWorkbenchDeclarationIdentity({
	kind: 'view',
	owner: definition,
	key: 'settings',
}) as WorkbenchViewDeclarationIdentity

const entry: WorkbenchLayoutEntry = Object.freeze({
	descriptor,
	target: Object.freeze({ node, displayName: 'Settings' }),
	renderer: node,
	definitionRevisions: Object.freeze({ target: 3, renderer: 3 }),
	placement: Object.freeze({ kind: 'tab', label: 'Settings', order: 0 }),
	federatedViewRef: Object.freeze({
		profile: 1,
		producer: 'pluxel_workbench_settings',
		buildRevision: 'build-3',
		manifestUrl: '/__pluxel/runtime/federation/pluxel_workbench_settings/build-3/mf-manifest.json',
		expose: './views/settings',
		descriptor,
	}),
})

describe('Workbench opened View client', () => {
	it('owns only the successful top-level Cap’n Web result', async () => {
		const disposeResult = vi.fn()
		const disposeApi = vi.fn()
		const result = {
			ok: true,
			value: {
				kind: 'local',
				api: { [Symbol.dispose]: disposeApi },
				params: {},
				federatedViewRef: entry.federatedViewRef,
			},
			[Symbol.dispose]: disposeResult,
		}
		const session = {
			openView: vi.fn().mockResolvedValue(result),
		} as unknown as RpcStub<WorkbenchSessionApi>

		const opened = await openWorkbenchView(session, entry, { layoutRevision: 7 })
		expect(opened.ok).toBe(true)
		if (!opened.ok) throw new Error('expected success')
		expect(opened.handle.active).toBe(true)
		expect(disposeResult).not.toHaveBeenCalled()

		opened.handle[Symbol.dispose]()
		opened.handle[Symbol.dispose]()
		expect(disposeResult).toHaveBeenCalledTimes(1)
		expect(disposeApi).not.toHaveBeenCalled()
	})

	it('disposes malformed or tuple-mismatched raw results before rejecting', async () => {
		const disposeResult = vi.fn()
		const wrongDescriptor = parseWorkbenchDeclarationIdentity({
			kind: 'view',
			owner: definition,
			key: 'other',
		})
		const session = {
			openView: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					kind: 'local',
					api: { [Symbol.dispose]() {} },
					params: {},
					federatedViewRef: { ...entry.federatedViewRef, descriptor: wrongDescriptor },
				},
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(openWorkbenchView(session, entry, { layoutRevision: 7 })).rejects.toThrow(
			'federation tuple',
		)
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

	it('returns a closed failure with no retained result', async () => {
		const disposeResult = vi.fn()
		const session = {
			openView: vi.fn().mockResolvedValue({
				ok: false,
				code: 'layout_changed',
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(openWorkbenchView(session, entry, { layoutRevision: 7 })).resolves.toEqual({
			ok: false,
			code: 'layout_changed',
		})
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

	it('rejects layout icon values outside the fixed host set', async () => {
		const disposeResult = vi.fn()
		const session = {
			layout: vi.fn().mockResolvedValue({
				profile: 1,
				revision: 1,
				target: null,
				entries: [{ ...entry, placement: { ...entry.placement, icon: 'remote-icon' } }],
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(readWorkbenchLayout(session, { target: null })).rejects.toThrow(
			'fixed Workbench icon set',
		)
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})
})

describe('remote value owner', () => {
	it('subscribes before reading and coalesces invalidation during an active read', async () => {
		const order: string[] = []
		const disposeSubscription = vi.fn()
		let invalidate: (() => void) | undefined
		let settleFirst: ((value: string) => void) | undefined
		let reads = 0
		const snapshots: unknown[] = []
		const value = createRemoteValue({
			subscribe(callback) {
				order.push('subscribe')
				invalidate = callback
				return { [Symbol.dispose]: disposeSubscription }
			},
			read() {
				reads += 1
				order.push(`read-${reads}`)
				if (reads === 1) return new Promise<string>((resolve) => (settleFirst = resolve))
				return Promise.resolve('latest')
			},
		})
		value.subscribe(() => snapshots.push(value.getSnapshot()))
		await Promise.resolve()
		expect(order).toEqual(['subscribe', 'read-1'])

		invalidate?.()
		invalidate?.()
		settleFirst?.('stale')
		await vi.waitFor(() => expect(value.getSnapshot()).toEqual({ state: 'ready', value: 'latest' }))
		expect(reads).toBe(2)
		expect(snapshots).not.toContainEqual({ state: 'ready', value: 'stale' })

		value[Symbol.dispose]()
		value[Symbol.dispose]()
		expect(disposeSubscription).toHaveBeenCalledTimes(1)
	})

	it('does not infer ownership of values returned by Plugin read functions', async () => {
		const disposeValue = vi.fn()
		const snapshotValue = Object.freeze({ value: 'detached', [Symbol.dispose]: disposeValue })
		const remote = createRemoteValue({ read: () => snapshotValue })

		await vi.waitFor(() =>
			expect(remote.getSnapshot()).toEqual({ state: 'ready', value: snapshotValue }),
		)
		expect(disposeValue).not.toHaveBeenCalled()

		remote[Symbol.dispose]()
		expect(disposeValue).not.toHaveBeenCalled()
	})

	it('disposes a synchronously returned subscription only once during startup cancellation', async () => {
		const disposeSubscription = vi.fn()
		const remote = createRemoteValue({
			read: () => 'unused',
			subscribe: () => ({ [Symbol.dispose]: disposeSubscription }),
		})

		remote[Symbol.dispose]()
		await Promise.resolve()
		expect(disposeSubscription).toHaveBeenCalledTimes(1)
	})
})
