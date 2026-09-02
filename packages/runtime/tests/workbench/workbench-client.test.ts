import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import {
	parseWorkbenchDeclarationIdentity,
	parseWorkbenchOpenableIdentity,
	type WorkbenchViewDeclarationIdentity,
} from '@pluxel/core/federation'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
	createRemoteValue,
	detachWorkbenchPortableValue,
	openWorkbenchEntry,
	readWorkbenchLayout,
	WorkbenchPortableValueError,
	type WorkbenchDetached,
	type WorkbenchLayoutEntry,
	type WorkbenchPortableValue,
	type WorkbenchPortableValueErrorCode,
	type WorkbenchSessionApi,
	type WorkbenchContentLayoutEntry,
	type WorkbenchUnavailableFederatedLayoutEntry,
} from '@pluxel/runtime/workbench/client'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import { serialize } from 'capnweb'

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

const contentDescriptor = parseWorkbenchOpenableIdentity({
	kind: 'content',
	owner: definition,
	key: 'guide',
})
if (contentDescriptor.kind !== 'content') throw new Error('unexpected Content identity')
const contentEntry: WorkbenchContentLayoutEntry = Object.freeze({
	descriptor: contentDescriptor,
	target: Object.freeze({ node, displayName: 'Settings' }),
	definitionRevisions: Object.freeze({ target: 3 }),
	placement: Object.freeze({ kind: 'tab', label: 'Guide', order: 0 }),
	contentRef: Object.freeze({
		profile: 1,
		digest: '1'.repeat(64),
		descriptor: contentDescriptor,
	}),
})

const unavailableEntry: WorkbenchUnavailableFederatedLayoutEntry = Object.freeze({
	descriptor,
	target: Object.freeze({ node, displayName: 'Settings' }),
	renderer: node,
	definitionRevisions: Object.freeze({ target: 3, renderer: 3 }),
	placement: Object.freeze({ kind: 'tab', label: 'Settings', order: 0 }),
	federatedViewUnavailable: Object.freeze({
		reason: 'failed',
		message: 'renderer syntax error',
	}),
})

describe('Workbench opened View client', () => {
	it('owns and validates a capability-free Workbench Content result', async () => {
		const disposeResult = vi.fn()
		const session = {
			openEntry: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					kind: 'content',
					mode: 'static',
					params: {},
					contentRef: contentEntry.contentRef,
					plan: {
						version: 1,
						kind: 'workbench-content',
						document: { version: 1, blocks: [] },
						slots: [],
					},
				},
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		const opened = await openWorkbenchEntry(session, contentEntry, { layoutRevision: 7 })
		expect(opened.ok).toBe(true)
		if (!opened.ok) throw new Error('expected Content success')
		expect(opened.handle.kind).toBe('content')
		expect(opened.handle.plan).toEqual({
			version: 1,
			kind: 'workbench-content',
			document: { version: 1, blocks: [] },
			slots: [],
		})
		expect(Object.isFrozen(opened.handle.plan.document.blocks)).toBe(true)

		opened.handle[Symbol.dispose]()
		opened.handle[Symbol.dispose]()
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

	it('disposes a Workbench Content result whose artifact tuple does not match layout', async () => {
		const disposeResult = vi.fn()
		const session = {
			openEntry: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					kind: 'content',
					mode: 'static',
					params: {},
					contentRef: { ...contentEntry.contentRef, digest: '2'.repeat(64) },
					plan: {
						version: 1,
						kind: 'workbench-content',
						document: { version: 1, blocks: [] },
						slots: [],
					},
				},
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(openWorkbenchEntry(session, contentEntry, { layoutRevision: 7 })).rejects.toThrow(
			'Workbench Content tuple',
		)
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

	it('rejects variant-crossing fields in an interactive Content presentation', async () => {
		const disposeResult = vi.fn()
		const session = {
			openEntry: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					kind: 'content',
					mode: 'interactive',
					params: {},
					contentRef: contentEntry.contentRef,
					plan: {
						version: 1,
						kind: 'workbench-content',
						document: {
							version: 1,
							blocks: [{ type: 'slot', key: 'refresh' }],
						},
						slots: [
							{
								kind: 'action',
								key: 'refresh',
								display: 'block',
								label: 'Refresh',
								input: 'none',
							},
						],
					},
					presentation: {
						slots: [
							{
								kind: 'action',
								key: 'refresh',
								label: 'Refresh',
								input: 'none',
								field: {},
							},
						],
					},
					root: { [Symbol.dispose]() {} },
				},
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(openWorkbenchEntry(session, contentEntry, { layoutRevision: 7 })).rejects.toThrow(
			'unsupported field field',
		)
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

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
			openEntry: vi.fn().mockResolvedValue(result),
		} as unknown as RpcStub<WorkbenchSessionApi>

		const opened = await openWorkbenchEntry(session, entry, { layoutRevision: 7 })
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
			openEntry: vi.fn().mockResolvedValue({
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

		await expect(openWorkbenchEntry(session, entry, { layoutRevision: 7 })).rejects.toThrow(
			'federation tuple',
		)
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

	it('returns a closed failure with no retained result', async () => {
		const disposeResult = vi.fn()
		const session = {
			openEntry: vi.fn().mockResolvedValue({
				ok: false,
				code: 'layout_changed',
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(openWorkbenchEntry(session, entry, { layoutRevision: 7 })).resolves.toEqual({
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

	it('accepts unavailable federated layout entries and does not open them', async () => {
		const disposeResult = vi.fn()
		const session = {
			layout: vi.fn().mockResolvedValue({
				profile: 1,
				revision: 1,
				target: null,
				entries: [unavailableEntry],
				[Symbol.dispose]: disposeResult,
			}),
			openEntry: vi.fn(),
		} as unknown as RpcStub<WorkbenchSessionApi>

		const layout = await readWorkbenchLayout(session, { target: null })
		expect(layout.entries[0]).toMatchObject({
			federatedViewUnavailable: {
				reason: 'failed',
				message: 'renderer syntax error',
			},
		})
		await expect(
			openWorkbenchEntry(session, layout.entries[0]!, { layoutRevision: 1 }),
		).resolves.toEqual({ ok: false, code: 'target_unavailable' })
		expect(session.openEntry).not.toHaveBeenCalled()
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})

	it('rejects federated layout entries with ambiguous availability', async () => {
		const disposeResult = vi.fn()
		const session = {
			layout: vi.fn().mockResolvedValue({
				profile: 1,
				revision: 1,
				target: null,
				entries: [
					{
						...entry,
						federatedViewUnavailable: { reason: 'building' },
					},
				],
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(readWorkbenchLayout(session, { target: null })).rejects.toThrow(
			'exactly one federated View availability field',
		)
		expect(disposeResult).toHaveBeenCalledTimes(1)
	})
})

describe('remote value owner', () => {
	it('detaches, validates, and releases a transport-owned portable DTO', () => {
		const dispose = vi.fn()
		const input = Object.assign(Object.create(null), {
			nested: Object.assign(Object.create(null), { value: 'safe' }),
		})
		Object.defineProperty(input, Symbol.dispose, { value: dispose })

		const detached = detachWorkbenchPortableValue(input, 'test Workbench DTO') as {
			readonly nested: Readonly<{ value: string }>
		}

		expect(detached).toEqual({ nested: { value: 'safe' } })
		expect(Object.getPrototypeOf(detached)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(detached.nested)).toBe(Object.prototype)
		expect(Object.isFrozen(detached)).toBe(true)
		expect(Object.isFrozen(detached.nested)).toBe(true)
		expect(Object.getOwnPropertySymbols(detached)).toEqual([])
		expect(() => serialize(detached)).not.toThrow()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('retains the synchronous overload and exposes deeply readonly output types', () => {
		const detached = detachWorkbenchPortableValue({
			nested: { value: 'safe' },
			items: [1, 2],
		})

		expect(detached).not.toBeInstanceOf(Promise)
		expectTypeOf(detached).toEqualTypeOf<{
			readonly nested: { readonly value: string }
			readonly items: readonly number[]
		}>()
		expectTypeOf<WorkbenchDetached<{ value: { count: number } }>>().toEqualTypeOf<{
			readonly value: { readonly count: number }
		}>()
		expectTypeOf<WorkbenchDetached<[string, { count: number }]>>().toEqualTypeOf<
			readonly [string, { readonly count: number }]
		>()
		expectTypeOf<WorkbenchPortableValueErrorCode>().toEqualTypeOf<
			| 'WORKBENCH_NON_PORTABLE_VALUE'
			| 'WORKBENCH_PORTABLE_VALUE_TOO_DEEP'
			| 'WORKBENCH_PORTABLE_VALUE_TOO_LARGE'
			| 'WORKBENCH_TRANSPORT_DISPOSE_FAILED'
		>()
		expectTypeOf<WorkbenchPortableValue>().toMatchTypeOf<
			null | boolean | number | string | readonly WorkbenchPortableValue[] | object
		>()
	})

	it('awaits a PromiseLike before detaching and releasing its resolved result', async () => {
		const dispose = vi.fn()
		const input = Object.defineProperty({ nested: { value: 'safe' } }, Symbol.dispose, {
			value: dispose,
		})

		const detached = detachWorkbenchPortableValue(Promise.resolve(input))
		expectTypeOf(detached).toEqualTypeOf<
			Promise<{
				readonly nested: { readonly value: string }
			}>
		>()
		await expect(detached).resolves.toEqual({ nested: { value: 'safe' } })
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('releases a transport-owned DTO when portable-data validation fails', () => {
		const dispose = vi.fn()
		const input = Object.defineProperty({ missing: undefined }, Symbol.dispose, {
			value: dispose,
		})

		expect(() => detachWorkbenchPortableValue(input)).toThrowError(
			expect.objectContaining({
				name: 'WorkbenchPortableValueError',
				code: 'WORKBENCH_NON_PORTABLE_VALUE',
			}),
		)
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('never invokes a nested disposer while releasing the transport-owned top level', () => {
		const disposeTopLevel = vi.fn()
		const disposeNested = vi.fn()
		const nested = Object.defineProperty({ value: 'unsafe' }, Symbol.dispose, {
			value: disposeNested,
		})
		const input = Object.defineProperty({ nested }, Symbol.dispose, { value: disposeTopLevel })

		expect(() => detachWorkbenchPortableValue(input)).toThrowError(
			expect.objectContaining({ code: 'WORKBENCH_NON_PORTABLE_VALUE' }),
		)
		expect(disposeTopLevel).toHaveBeenCalledOnce()
		expect(disposeNested).not.toHaveBeenCalled()
	})

	it('reports a disposer failure with its stable code and cause', () => {
		const cleanupFailure = new Error('socket cleanup failed')
		const dispose = vi.fn(() => {
			throw cleanupFailure
		})
		const input = Object.defineProperty({ value: 'safe' }, Symbol.dispose, { value: dispose })

		let error: unknown
		try {
			detachWorkbenchPortableValue(input)
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(WorkbenchPortableValueError)
		expect(error).toMatchObject({
			code: 'WORKBENCH_TRANSPORT_DISPOSE_FAILED',
			cause: cleanupFailure,
		})
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('preserves the portable error code when validation and cleanup both fail', () => {
		const cleanupFailure = new Error('socket cleanup failed')
		const dispose = vi.fn(() => {
			throw cleanupFailure
		})
		const input = Object.defineProperty({ credential: undefined }, Symbol.dispose, {
			value: dispose,
		})

		let error: unknown
		try {
			detachWorkbenchPortableValue(input, 'settings payload')
		} catch (caught) {
			error = caught
		}
		expect(error).toMatchObject({
			code: 'WORKBENCH_NON_PORTABLE_VALUE',
			cause: cleanupFailure,
		})
		expect((error as Error).message).toContain('settings payload')
		expect((error as Error).message).not.toContain('credential')
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('uses distinct stable codes for depth and size limits', () => {
		let tooDeep: Record<string, unknown> = {}
		for (let depth = 0; depth < 66; depth += 1) tooDeep = { nested: tooDeep }

		expect(() => detachWorkbenchPortableValue(tooDeep)).toThrowError(
			expect.objectContaining({ code: 'WORKBENCH_PORTABLE_VALUE_TOO_DEEP' }),
		)
		expect(() =>
			detachWorkbenchPortableValue(Array.from({ length: 10_001 }, () => 0)),
		).toThrowError(expect.objectContaining({ code: 'WORKBENCH_PORTABLE_VALUE_TOO_LARGE' }))
	})

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
