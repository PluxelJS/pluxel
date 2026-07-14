import { describe, expect, expectTypeOf, it } from 'vitest'
import * as Management from '@pluxel/runtime/management'
import * as ManagementUi from '@pluxel/runtime/management/ui'
import { createRuntimeContext } from '@pluxel/runtime/test'

describe('Management Plane public API', () => {
	it('exports only the new module, port, resource and UI authoring surfaces', () => {
		expect(Management.defineManagementModule).toBeTypeOf('function')
		expect(Management.defineManagementPort).toBeTypeOf('function')
		expect(Management.managementView).toBeTypeOf('function')
		expect(Management.managementPort).toBeTypeOf('function')
		expect(Management.managementPortRenderer).toBeTypeOf('function')
		expect(Management.managementBinding).toBeTypeOf('object')
		expect(ManagementUi.managementApp).toBeTypeOf('function')
	})

	it('creates immutable, typed declarations', () => {
		const module = Management.defineManagementModule({
			id: 'Example',
			resources: { api: Management.managementResource.api<{ ping(): string }>() },
		})
		expect(module).toMatchObject({ id: 'Example', resources: { api: { kind: 'api' } } })
		expect(Object.isFrozen(module)).toBe(true)
		expect(Object.isFrozen(module.resources)).toBe(true)
	})

	it('types browser API methods as asynchronous RPC calls', () => {
		type Api = {
			ping(input: string): string
			save(): Promise<number>
			localState: string
		}
		type Client = Management.ManagementApiClient<Api>
		expectTypeOf<ReturnType<Client['ping']>>().toEqualTypeOf<Promise<string>>()
		expectTypeOf<ReturnType<Client['save']>>().toEqualTypeOf<Promise<number>>()
		expectTypeOf<Client>().not.toHaveProperty('localState')
	})

	it('defines UI exports from the same typed app used by views', () => {
		const module = Management.defineManagementModule({ id: 'UiExample' })
		const app = ManagementUi.managementApp<typeof module>()
		const Overview = () => null
		const ui = app.define({ Overview })
		expect(ui.views).toEqual({ Overview })
		expect(Object.isFrozen(app)).toBe(true)
		expect(Object.isFrozen(ui)).toBe(true)
		expect(Object.isFrozen(ui.views)).toBe(true)
		expect(() => app.define({ invalid: null as never })).toThrow('invalid view export')
	})

	it('keeps the optional capability inert when disabled', async () => {
		const runtime = createRuntimeContext({ management: false })
		try {
			expect(runtime.ctx.management.enabled).toBe(false)
			const module = Management.defineManagementModule({ id: 'Disabled' })
			expect(runtime.ctx.management.mount(module, {})).toBeUndefined()
		} finally {
			await runtime.dispose()
		}
	})
})
