// @vitest-environment jsdom

import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import { parseWorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import {
	openWorkbenchView,
	type WorkbenchLayoutEntry,
	type WorkbenchSessionApi,
} from '@pluxel/runtime/workbench/client'
import {
	createWorkbenchBridge,
	readWorkbenchBridgeIdentity,
	readWorkbenchBridgeProvider,
} from '@pluxel/runtime/internal/workbench-react'
import { useWorkbench, type WorkbenchHostFacade } from '@pluxel/runtime/workbench/react'

interface SettingsApi extends RpcTarget {
	snapshot(): Readonly<{ enabled: boolean }>
}

const renderer = workbench.entry(import.meta.url, './fixtures/settings.tsx')
const SettingsWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.tab({ label: 'Settings' }),
	}),
})
const SameNamedOtherWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.tab({ label: 'Other' }),
	}),
})
const owner = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/settings' },
	exportName: 'SettingsPlugin',
})
const node = parsePluginNodeAddress({ definition: owner, variant: 'default' })
const identity = parseWorkbenchDeclarationIdentity({
	kind: 'view',
	owner,
	key: 'settings',
})
const federatedViewRef = Object.freeze({
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
	federatedViewRef,
})
const host: WorkbenchHostFacade = Object.freeze({
	locale: 'en',
	colorScheme: 'light',
	notify: vi.fn(),
	confirm: vi.fn().mockResolvedValue(true),
	navigation: null,
	document: null,
})

async function openedHandle(api: object) {
	const session = {
		openView: vi.fn().mockResolvedValue({
			ok: true,
			value: { kind: 'local', api, params: {}, federatedViewRef },
			[Symbol.dispose]() {},
		}),
	} as unknown as RpcStub<WorkbenchSessionApi>
	const opened = await openWorkbenchView(session, entry, { layoutRevision: 1 })
	if (!opened.ok) throw new Error('expected open success')
	return opened.handle
}

describe('generated Workbench React Bridge', () => {
	it('keeps renderer props empty and projects the exact descriptor-bound stub', async () => {
		const api = { snapshot: vi.fn(), [Symbol.dispose]() {} }
		const handle = await openedHandle(api)
		let observed: ReturnType<typeof useWorkbench<typeof SettingsWorkbench.settings>> | undefined
		let observedProps: object | undefined
		function Settings(props: object) {
			observedProps = props
			observed = useWorkbench(SettingsWorkbench.settings)
			return <p>ready</p>
		}
		const provider = createWorkbenchBridge(identity, SettingsWorkbench.settings, Settings)
		expect(readWorkbenchBridgeProvider(provider)).toBe(provider)
		expect(readWorkbenchBridgeIdentity(provider)).toEqual(identity)
		const application = provider()
		const dom = document.createElement('div')

		await act(() =>
			application.render({
				dom,
				moduleName: 'pluxel_workbench_settings/views/settings',
				__pluxelWorkbench: { profile: 1, handle, host },
			}),
		)
		expect(dom.textContent).toBe('ready')
		expect(Object.keys(observedProps ?? {})).toEqual([])
		expect(observed?.api).toBe(api)
		expect(observed?.host).toBe(host)

		act(() => application.destroy({ dom, moduleName: 'settings' }))
		handle[Symbol.dispose]()
	})

	it('rejects a same-kind, same-key descriptor object from another definition', async () => {
		const apiCall = vi.fn()
		const handle = await openedHandle({ snapshot: apiCall, [Symbol.dispose]() {} })
		function WrongRenderer() {
			const { api } = useWorkbench(SameNamedOtherWorkbench.settings)
			void api.snapshot()
			return null
		}
		const application = createWorkbenchBridge(identity, SettingsWorkbench.settings, WrongRenderer)()
		const dom = document.createElement('div')

		await act(() =>
			application.render({
				dom,
				moduleName: 'pluxel_workbench_settings/views/settings',
				__pluxelWorkbench: { profile: 1, handle, host },
			}),
		)
		expect(dom.textContent).toContain('descriptor does not belong to this renderer')
		expect(apiCall).not.toHaveBeenCalled()

		act(() => application.destroy({ dom, moduleName: 'settings' }))
		handle[Symbol.dispose]()
	})
})
