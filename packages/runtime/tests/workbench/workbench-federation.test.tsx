// @vitest-environment jsdom

import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import { parseWorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import { act, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import type { WorkbenchLayoutEntry, WorkbenchSessionApi } from '@pluxel/runtime/workbench/client'
import {
	createWorkbenchViewHost,
	openFederatedWorkbenchView,
} from '@pluxel/runtime/workbench/federation'
import { createWorkbenchBridge } from '@pluxel/runtime/internal/workbench-react'

const mf = vi.hoisted(() => ({
	createInstance: vi.fn(),
	registerRemotes: vi.fn(),
	loadRemote: vi.fn(),
}))

vi.mock('@module-federation/runtime', () => ({ createInstance: mf.createInstance }))

interface SettingsApi extends RpcTarget {}

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/settings' },
	exportName: 'SettingsPlugin',
})
const node = parsePluginNodeAddress({ definition, variant: 'default' })
const identity = parseWorkbenchDeclarationIdentity({
	kind: 'view',
	owner: definition,
	key: 'settings',
})
const renderer = workbench.entry(import.meta.url, './fixtures/settings.tsx')
const SettingsWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({ renderer, placement: workbench.tab() }),
})
const ref = Object.freeze({
	profile: 1 as const,
	producer: 'pluxel_workbench_settings',
	buildRevision: 'build-1',
	manifestUrl: '/__pluxel/runtime/federation/pluxel_workbench_settings/build-1/mf-manifest.json',
	expose: './views/settings' as const,
	descriptor: identity,
})
const entry: WorkbenchLayoutEntry = Object.freeze({
	descriptor: identity as Extract<typeof identity, { kind: 'view' }>,
	target: Object.freeze({ node, displayName: 'Settings' }),
	renderer: node,
	definitionRevisions: Object.freeze({ target: 1, renderer: 1 }),
	placement: SettingsWorkbench.settings.placement,
	federatedViewRef: ref,
})

const stateKey = Symbol.for('pluxel.workbench.federation.profile1')

beforeEach(() => {
	delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[stateKey]
	mf.createInstance.mockReset().mockReturnValue({
		registerRemotes: mf.registerRemotes,
		loadRemote: mf.loadRemote,
	})
	mf.registerRemotes.mockReset()
	mf.loadRemote.mockReset()
})

describe('Workbench Federation activation', () => {
	it('uses one immutable remote and destroys Bridge before host and RPC ownership', async () => {
		const order: string[] = []
		function Renderer() {
			useEffect(() => () => void order.push('bridge'), [])
			return <p>federated</p>
		}
		const provider = createWorkbenchBridge(identity, SettingsWorkbench.settings, Renderer)
		mf.loadRemote.mockResolvedValue({ default: provider })
		const disposeResult = vi.fn(() => order.push('rpc'))
		const session = {
			openView: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					kind: 'local',
					api: { [Symbol.dispose]() {} },
					params: {},
					federatedViewRef: ref,
				},
				[Symbol.dispose]: disposeResult,
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>
		const host = createWorkbenchViewHost({
			locale: 'en',
			colorScheme: 'light',
			notify() {},
			confirm: async () => true,
			document: {
				params: {},
				setDirty(dirty) {
					if (!dirty) order.push('dirty')
				},
				setTitle() {},
				reset() {
					order.push('host')
				},
			},
		})
		const dom = document.createElement('div')

		let opened: Awaited<ReturnType<typeof openFederatedWorkbenchView>> | undefined
		await act(async () => {
			opened = await openFederatedWorkbenchView({
				session,
				entry,
				layoutRevision: 1,
				dom,
				host,
			})
		})
		if (!opened) throw new Error('activation did not settle')
		expect(opened.ok).toBe(true)
		if (!opened.ok) throw new Error('expected activation')
		expect(dom.textContent).toBe('federated')
		expect(mf.registerRemotes).toHaveBeenCalledWith([
			{ name: ref.producer, entry: ref.manifestUrl, type: 'module' },
		])
		expect(mf.loadRemote).toHaveBeenCalledWith('pluxel_workbench_settings/views/settings', {
			from: 'runtime',
		})
		expect(mf.registerRemotes.mock.calls[0]?.[1]).toBeUndefined()

		act(() => opened.view[Symbol.dispose]())
		expect(order).toEqual(['bridge', 'dirty', 'host', 'rpc'])
		expect(disposeResult).toHaveBeenCalledTimes(1)

		const options = mf.createInstance.mock.calls[0]?.[0] as {
			name: string
			shareStrategy: string
			shared: Record<string, unknown>
			plugins: unknown[]
		}
		expect(options.name).toBe('pluxel_workbench_profile1')
		expect(options.shareStrategy).toBe('loaded-first')
		expect(Object.keys(options.shared).sort()).toEqual(
			[
				'@mantine/core',
				'@mantine/hooks',
				'@module-federation/bridge-react',
				'@pluxel/runtime/internal/workbench-react',
				'@pluxel/runtime/workbench',
				'@pluxel/runtime/workbench/client',
				'@pluxel/runtime/workbench/react',
				'react',
				'react-dom',
				'react-dom/client',
				'react/jsx-dev-runtime',
				'react/jsx-runtime',
			].sort(),
		)
		expect(options.plugins).toHaveLength(1)
	})

	it('does not force-replace a producer revision inside one document', async () => {
		const provider = createWorkbenchBridge(identity, SettingsWorkbench.settings, () => null)
		mf.loadRemote.mockResolvedValue({ default: provider })
		const resultDisposers: Array<ReturnType<typeof vi.fn>> = []
		const changedRef = Object.freeze({
			...ref,
			buildRevision: 'build-2',
			manifestUrl:
				'/__pluxel/runtime/federation/pluxel_workbench_settings/build-2/mf-manifest.json',
		})
		const session = {
			openView: vi.fn().mockImplementation(async () => {
				const dispose = vi.fn()
				resultDisposers.push(dispose)
				const currentRef = resultDisposers.length === 1 ? ref : changedRef
				return {
					ok: true,
					value: {
						kind: 'local',
						api: { [Symbol.dispose]() {} },
						params: {},
						federatedViewRef: currentRef,
					},
					[Symbol.dispose]: dispose,
				}
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>
		const createHost = () =>
			createWorkbenchViewHost({
				locale: 'en',
				colorScheme: 'light',
				notify() {},
				confirm: async () => true,
			})

		const first = await openFederatedWorkbenchView({
			session,
			entry,
			layoutRevision: 1,
			dom: document.createElement('div'),
			host: createHost(),
		})
		expect(first.ok).toBe(true)
		if (first.ok) first.view[Symbol.dispose]()

		const changedEntry = {
			...entry,
			federatedViewRef: changedRef,
		} as WorkbenchLayoutEntry
		await expect(
			openFederatedWorkbenchView({
				session,
				entry: changedEntry,
				layoutRevision: 2,
				dom: document.createElement('div'),
				host: createHost(),
			}),
		).rejects.toThrow('changed revision inside one document')
		expect(mf.registerRemotes).toHaveBeenCalledTimes(1)
		expect(resultDisposers[1]).toHaveBeenCalledTimes(1)
	})

	it('closes the per-open host when openView rejects before returning a result', async () => {
		const reset = vi.fn()
		const host = createWorkbenchViewHost({
			locale: 'en',
			colorScheme: 'light',
			notify() {},
			confirm: async () => true,
			document: {
				params: {},
				setDirty() {},
				setTitle() {},
				reset,
			},
		})
		const session = {
			openView: vi.fn().mockRejectedValue(new Error('socket closed')),
		} as unknown as RpcStub<WorkbenchSessionApi>

		await expect(
			openFederatedWorkbenchView({
				session,
				entry,
				layoutRevision: 1,
				dom: document.createElement('div'),
				host,
			}),
		).rejects.toThrow('socket closed')
		expect(host.active).toBe(false)
		expect(reset).toHaveBeenCalledTimes(1)
	})

	it('releases a late RPC result when its host closes during activation', async () => {
		let resolveOpen!: (value: unknown) => void
		const disposeResult = vi.fn()
		const session = {
			openView: vi.fn().mockReturnValue(
				new Promise((resolve) => {
					resolveOpen = resolve
				}),
			),
		} as unknown as RpcStub<WorkbenchSessionApi>
		const host = createWorkbenchViewHost({
			locale: 'en',
			colorScheme: 'light',
			notify() {},
			confirm: async () => true,
		})
		const opening = openFederatedWorkbenchView({
			session,
			entry,
			layoutRevision: 1,
			dom: document.createElement('div'),
			host,
		})

		host[Symbol.dispose]()
		resolveOpen({
			ok: true,
			value: {
				kind: 'local',
				api: { [Symbol.dispose]() {} },
				params: {},
				federatedViewRef: ref,
			},
			[Symbol.dispose]: disposeResult,
		})

		await expect(opening).rejects.toThrow('host closed during activation')
		expect(disposeResult).toHaveBeenCalledTimes(1)
		expect(mf.loadRemote).not.toHaveBeenCalled()
	})

	it('validates renderer-to-host notification and confirmation input', async () => {
		const notify = vi.fn()
		const confirm = vi.fn(async () => true)
		const host = createWorkbenchViewHost({
			locale: 'en',
			colorScheme: 'light',
			notify,
			confirm,
		})
		expect(host.facade.locale).toBe('en')
		host.updateAppearance({ locale: 'zh-HK', colorScheme: 'dark' })
		expect(host.facade.locale).toBe('zh-HK')
		expect(host.facade.colorScheme).toBe('dark')

		expect(() => host.facade.notify({ message: '' })).toThrow('notification message is invalid')
		expect(() => host.facade.notify({ message: 'hello', compatibility: true } as never)).toThrow(
			'unsupported field compatibility',
		)
		expect(() => host.facade.confirm({ message: 'continue?', tone: 'urgent' } as never)).toThrow(
			'confirmation tone is invalid',
		)
		expect(notify).not.toHaveBeenCalled()
		expect(confirm).not.toHaveBeenCalled()
		host.facade.notify({ message: 'saved', tone: 'success' })
		await expect(host.facade.confirm({ message: 'continue?', tone: 'danger' })).resolves.toBe(true)
		expect(notify).toHaveBeenCalledWith({ message: 'saved', tone: 'success' })
		expect(confirm).toHaveBeenCalledWith({ message: 'continue?', tone: 'danger' })
	})

	it('rejects malformed Shell bindings and confirmation results', async () => {
		const host = createWorkbenchViewHost({
			locale: 'en',
			colorScheme: 'light',
			notify() {},
			confirm: async () => 'yes' as never,
		})
		await expect(host.facade.confirm({ message: 'continue?' })).rejects.toThrow(
			'confirm result must be boolean',
		)
	})
})
