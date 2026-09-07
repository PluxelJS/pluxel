// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import { parseWorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type {
	WorkbenchSessionApi,
	WorkbenchUnavailableFederatedLayoutEntry,
} from '@pluxel/runtime/workbench/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
	WorkbenchEntryView,
	WorkbenchRuntimeProvider,
	WorkbenchSessionProvider,
	type WorkbenchBrowserHost,
} from '../src/workbench/runtime'

const federationMocks = vi.hoisted(() => ({
	openFederatedWorkbenchView: vi.fn(),
}))

vi.mock('@pluxel/runtime/workbench/federation', async (importOriginal) => ({
	...(await importOriginal<typeof import('@pluxel/runtime/workbench/federation')>()),
	openFederatedWorkbenchView: federationMocks.openFederatedWorkbenchView,
}))

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/settings' },
	exportName: 'SettingsPlugin',
})
const node = parsePluginNodeAddress({ definition, variant: 'default' })
const descriptor = parseWorkbenchDeclarationIdentity({
	kind: 'view',
	owner: definition,
	key: 'settings',
})
if (descriptor.kind !== 'view') throw new Error('unexpected descriptor')

const entry: WorkbenchUnavailableFederatedLayoutEntry = Object.freeze({
	descriptor,
	target: Object.freeze({ node, displayName: 'Settings' }),
	renderer: node,
	definitionRevisions: Object.freeze({ target: 1, renderer: 1 }),
	placement: Object.freeze({ kind: 'tab', label: 'Settings', order: 0 }),
	federatedViewUnavailable: Object.freeze({
		reason: 'failed',
		message: 'renderer syntax error',
	}),
})

const session = Object.freeze({
	openEntry: vi.fn(),
	layout: vi.fn(),
}) as unknown as RpcStub<WorkbenchSessionApi>

const host: WorkbenchBrowserHost = Object.freeze({
	locale: 'zh-Hans',
	colorScheme: 'light',
	notify: vi.fn(),
	confirm: vi.fn(async () => true),
	runningPluginKeys: new Set(),
	runningPluginsReady: true,
})

describe('Workbench federated availability', () => {
	it('renders producer failures in place without opening federation', () => {
		const markup = renderToStaticMarkup(
			<MantineProvider>
				<WorkbenchSessionProvider session={session}>
					<WorkbenchRuntimeProvider host={host}>
						<WorkbenchEntryView entry={entry} frame="shell" layoutRevision={7} params={{}} />
					</WorkbenchRuntimeProvider>
				</WorkbenchSessionProvider>
			</MantineProvider>,
		)

		expect(markup).toContain('Workbench View 构建失败')
		expect(markup).toContain('renderer syntax error')
		expect(federationMocks.openFederatedWorkbenchView).not.toHaveBeenCalled()
	})
})
