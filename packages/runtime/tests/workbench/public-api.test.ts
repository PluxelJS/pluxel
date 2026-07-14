import { describe, expect, expectTypeOf, it } from 'vitest'
import { workbench, type WorkbenchRpcClient } from '@pluxel/runtime/workbench'
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { requireWorkbench } from '../../src/services/workbench'

describe('Workbench authoring API', () => {
	it('defines one immutable extension with explicit view model grants', () => {
		const extension = workbench.define({
			plugin: 'Example',
			model: { commands: workbench.model.rpc<{ ping(): string }>() },
			views: (model) => ({
				Overview: workbench.view.remote({
					model: [model.commands],
					placements: [workbench.place.slot({ slot: workbench.slot.PluginTabs })],
				}),
			}),
		})
		expect(extension).toMatchObject({
			plugin: 'Example',
			model: { commands: { kind: 'rpc' } },
			views: { Overview: { model: ['commands'] } },
		})
		expect(Object.isFrozen(extension)).toBe(true)
	})

	it('types server RPC methods as asynchronous browser calls', () => {
		type Rpc = { ping(input: string): string; save(): Promise<number>; localState: string }
		type Client = WorkbenchRpcClient<Rpc>
		expectTypeOf<ReturnType<Client['ping']>>().toEqualTypeOf<Promise<string>>()
		expectTypeOf<ReturnType<Client['save']>>().toEqualTypeOf<Promise<number>>()
		expectTypeOf<Client>().not.toHaveProperty('localState')
	})

	it('exposes exactly the declared UI views', () => {
		const extension = workbench.define({
			plugin: 'UiExample',
			views: () => ({
				Overview: workbench.view.remote({
					placements: [workbench.place.slot({ slot: workbench.slot.PluginTabs })],
				}),
			}),
		})
		const ui = createWorkbenchUi<typeof extension>()
		const Overview = () => null
		const module = ui.expose({ Overview })
		expect(module.views).toEqual({ Overview })
		expect(() => ui.expose({ Overview: null as never })).toThrow('invalid view export')
	})

	it('keeps the optional capability inert when disabled', async () => {
		const runtime = createRuntimeContext({ workbench: false })
		try {
			expect(runtime.ctx.workbench.enabled).toBe(false)
			const extension = workbench.define({ plugin: 'Disabled' })
			expect(runtime.ctx.workbench.mount(extension, {})).toBeUndefined()
		} finally {
			await runtime.dispose()
		}
	})

	it('replaces a stale mount when HMR creates a new owner Context', async () => {
		const runtime = createRuntimeContext()
		try {
			const extension = workbench.define({ plugin: 'Owner' })
			const first = pluginContext(runtime.ctx, 'Owner')
			const second = pluginContext(runtime.ctx, 'Owner')
			const backend = requireWorkbench(runtime.ctx)

			backend.forContext(first.ctx).mount(extension, {})
			expect(() => backend.forContext(first.ctx).mount(extension, {})).toThrow('already mounted')
			expect(() => backend.forContext(second.ctx).mount(extension, {})).not.toThrow()
			expect(first.disposed()).toBe(true)
		} finally {
			await runtime.dispose()
		}
	})
})

function pluginContext(root: object, id: string) {
	const ctx = Object.create(root) as any
	let disposed = false
	Object.defineProperties(ctx, {
		pluginInfo: { value: { id }, configurable: true },
		effects: {
			value: {
				defer(cleanup: () => void) {
					let active = true
					return {
						dispose() {
							if (!active) return
							active = false
							disposed = true
							cleanup()
						},
					}
				},
			},
			configurable: true,
		},
	})
	return { ctx, disposed: () => disposed }
}
