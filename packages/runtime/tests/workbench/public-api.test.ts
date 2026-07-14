import { describe, expect, expectTypeOf, it } from 'vitest'
import { workbench, type WorkbenchRpcClient } from '@pluxel/runtime/workbench'
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { createRuntimeContext } from '@pluxel/runtime/test'

describe('Workbench authoring API', () => {
	it('defines one immutable extension with explicit view model grants', () => {
		const extension = workbench.define({
			plugin: 'Example',
			model: { commands: workbench.model.rpc<{ ping(): string }>() },
			views: {
				Overview: workbench.view.slot({
					slot: workbench.slot.PluginTabs,
					model: ['commands'],
				}),
			},
		})
		expect(extension).toMatchObject({
			plugin: 'Example',
			model: { commands: { kind: 'rpc' } },
			views: { Overview: { model: ['commands'] } },
		})
		expect(Object.isFrozen(extension)).toBe(true)
		expect(() =>
			workbench.define({
				plugin: 'Invalid',
				views: { Broken: workbench.view.slot({ slot: workbench.slot.PluginTabs, model: ['x'] }) },
			}),
		).toThrow('selects unknown model')
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
			views: { Overview: workbench.view.slot({ slot: workbench.slot.PluginTabs }) },
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
})
