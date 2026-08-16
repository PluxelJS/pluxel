import { workbenchFederationSharedPackages } from '@pluxel/core/federation'
import { beforeEach, expect, it, vi } from 'vitest'

const federation = vi.hoisted(() => ({
	createInstance: vi.fn(),
	runtime: {
		registerRemotes: vi.fn(),
		loadRemote: vi.fn(),
	},
}))

vi.mock('@module-federation/runtime', () => ({ createInstance: federation.createInstance }))
vi.mock('@pluxel/runtime/workbench/contract', () => ({ workbenchContract: {} }))
vi.mock('@pluxel/runtime/workbench/ui', () => ({ createWorkbenchUi: vi.fn() }))

import { loadFederatedWorkbenchModule } from '../src/workbench/federationRuntime'

const stateKey = Symbol.for('pluxel.workbench.federation-runtime')
const firstArtifact: Parameters<typeof loadFederatedWorkbenchModule>[0] = {
	owner: {
		address: {
			definition: {
				entry: { kind: 'source-entry', source: 'tests/Billing.ts' },
				exportName: 'Billing',
			},
			instance: 'default',
		},
		displayName: 'Billing',
		rootExportName: 'Billing',
	},
	remoteName: 'pluxel_workbench_billing',
	remoteEntryUrl: '/workbench/billing/remoteEntry.js',
	exposedModule: './ui-module',
	sourceHash: 'source-a',
	compiledAt: 1,
}

beforeEach(() => {
	delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[stateKey]
	federation.createInstance.mockReset().mockReturnValue(federation.runtime)
	federation.runtime.registerRemotes.mockReset()
	federation.runtime.loadRemote.mockReset().mockResolvedValue({})
})

it('provides every declared shared package and force-replaces only changed remote entries', async () => {
	await loadFederatedWorkbenchModule(firstArtifact)
	await loadFederatedWorkbenchModule(firstArtifact)
	await loadFederatedWorkbenchModule({ ...firstArtifact, sourceHash: 'source-b', compiledAt: 2 })

	const hostOptions = federation.createInstance.mock.calls[0]?.[0] as {
		shared: Record<string, unknown>
	}
	expect(Object.keys(hostOptions.shared).sort()).toEqual(
		[...workbenchFederationSharedPackages].sort(),
	)
	expect(Object.keys(hostOptions.shared)).not.toContain('@worksplit/react')
	expect(federation.runtime.registerRemotes).toHaveBeenCalledTimes(2)
	expect(federation.runtime.registerRemotes).toHaveBeenNthCalledWith(
		1,
		[
			{
				name: firstArtifact.remoteName,
				entry: `${firstArtifact.remoteEntryUrl}?v=source-a:1`,
				type: 'module',
			},
		],
		undefined,
	)
	expect(federation.runtime.registerRemotes).toHaveBeenNthCalledWith(
		2,
		[
			{
				name: firstArtifact.remoteName,
				entry: `${firstArtifact.remoteEntryUrl}?v=source-b:2`,
				type: 'module',
			},
		],
		{ force: true },
	)
	expect(federation.runtime.loadRemote).toHaveBeenCalledTimes(3)
	for (const [moduleId] of federation.runtime.loadRemote.mock.calls) {
		expect(moduleId).toBe(`${firstArtifact.remoteName}/ui-module`)
	}
})
