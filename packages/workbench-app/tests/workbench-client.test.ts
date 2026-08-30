import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import { parseWorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type { WorkbenchLayout, WorkbenchSessionApi } from '@pluxel/runtime/workbench/client'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchLayoutRuntime } from '../src/workbench/client'

const definition = parsePluginDefinitionAddress({
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'tests/BotPlugin.ts' },
	exportName: 'BotPlugin',
})
const node = parsePluginNodeAddress({ definition, variant: 'default' })
const panelDescriptor = parseWorkbenchDeclarationIdentity({
	kind: 'view',
	owner: definition,
	key: 'panel',
})
const accountDescriptor = parseWorkbenchDeclarationIdentity({
	kind: 'view',
	owner: definition,
	key: 'account',
})

function federatedRef(descriptor: typeof panelDescriptor) {
	return Object.freeze({
		profile: 1 as const,
		producer: 'pluxel_workbench_bot',
		buildRevision: 'build-1',
		manifestUrl: '/__pluxel/runtime/federation/pluxel_workbench_bot/build-1/mf-manifest.json',
		expose: `./views/${descriptor.key}` as const,
		descriptor,
	})
}

function layout(): WorkbenchLayout {
	return Object.freeze({
		profile: 1,
		revision: 7,
		target: Object.freeze({ node, displayName: 'Bot Manager' }),
		entries: Object.freeze([
			Object.freeze({
				descriptor: panelDescriptor,
				target: Object.freeze({ node, displayName: 'Bot Manager' }),
				renderer: node,
				definitionRevisions: Object.freeze({ target: 1, renderer: 1 }),
				placement: Object.freeze({ kind: 'tab' as const, label: 'Bots', order: 0 }),
				federatedViewRef: federatedRef(panelDescriptor),
			}),
			Object.freeze({
				descriptor: accountDescriptor,
				target: Object.freeze({ node, displayName: 'Bot Manager' }),
				renderer: node,
				definitionRevisions: Object.freeze({ target: 1, renderer: 1 }),
				placement: Object.freeze({
					kind: 'route' as const,
					path: '/accounts/:accountId',
					title: 'Account',
					frame: 'shell' as const,
					order: 0,
				}),
				federatedViewRef: federatedRef(accountDescriptor),
			}),
		]),
	})
}

function fixture() {
	const dispose = vi.fn()
	const read = vi.fn(async () => ({ ...layout(), [Symbol.dispose]: dispose }))
	const session = { layout: read } as unknown as RpcStub<WorkbenchSessionApi>
	return { dispose, read, runtime: new WorkbenchLayoutRuntime(session) }
}

async function ready(runtime: WorkbenchLayoutRuntime) {
	if (runtime.getSnapshot(node).state === 'ready') return
	await new Promise<void>((resolve) => {
		const unsubscribe = runtime.subscribe(node, () => {
			if (runtime.getSnapshot(node).state !== 'ready') return
			unsubscribe()
			resolve()
		})
	})
}

describe('one-epoch Workbench layout runtime', () => {
	it('compiles tabs and routes from one capability-free layout', async () => {
		const source = fixture()
		const release = source.runtime.retain(node)
		await ready(source.runtime)

		const snapshot = source.runtime.getSnapshot(node)
		expect(snapshot.tabs.map((entry) => entry.descriptor.key)).toEqual(['panel'])
		expect(source.runtime.resolveRoute(node, '/accounts/primary')?.params).toEqual({
			accountId: 'primary',
		})
		expect(snapshot.layout?.revision).toBe(7)
		expect(source.dispose).toHaveBeenCalledOnce()

		release()
		source.runtime[Symbol.dispose]()
	})

	it('reuses the same read across React effect cleanup replay', async () => {
		const source = fixture()
		const releaseFirst = source.runtime.retain(node)
		releaseFirst()
		const releaseReplay = source.runtime.retain(node)
		await ready(source.runtime)

		expect(source.read).toHaveBeenCalledOnce()
		expect(source.runtime.getSnapshot(node).state).toBe('ready')
		releaseReplay()
		source.runtime[Symbol.dispose]()
	})
})
