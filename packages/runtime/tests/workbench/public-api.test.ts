import { describe, expect, expectTypeOf, it } from 'vitest'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { createWorkbenchUi, type WorkbenchRpcClient } from '@pluxel/runtime/workbench/ui'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { requireWorkbench } from '../../src/services/workbench'

describe('Workbench authoring API', () => {
	it('defines an immutable browser Contract and server Extension', () => {
		const contract = workbenchContract.define({
			resources: { commands: workbenchContract.rpc<{ ping(): string }>() },
			views: {
				Overview: {
					placements: [workbenchContract.slot(workbenchContract.slots.PluginTabs)],
				},
			},
		})
		const extension = workbench.extension({ contract })
		expect(contract).toMatchObject({
			resources: { commands: { kind: 'rpc' } },
			views: { Overview: { kind: 'view' } },
		})
		expect(extension.contract).toBe(contract)
		expect(Object.isFrozen(extension)).toBe(true)
	})

	it('creates a one-to-one consumer Port outlet without repeating resource declarations', () => {
		const SettingsPort = workbenchContract.port({
			id: 'example.settings',
			resources: { settings: workbenchContract.rpc<{ get(): string }>() },
		})
		const extension = workbench.portOutlet({
			id: 'Http',
			port: SettingsPort,
			placement: workbenchContract.slot(workbenchContract.slots.PluginTabs, {
				label: 'HTTP',
			}),
		})

		expect(extension.contract.resources).toEqual(SettingsPort.resources)
		expect(extension.contract.ports).toEqual([
			expect.objectContaining({
				kind: 'port',
				id: 'Http',
				port: SettingsPort,
				provide: { settings: 'settings' },
			}),
		])
	})

	it('defines grouped global navigation without changing the route owner', () => {
		const placement = workbenchContract.route('/settings', {
			title: 'Telegram Bots',
			icon: workbenchContract.icons.BrandTelegram,
			navigation: {
				label: 'Telegram',
				group: {
					id: 'bots',
					label: 'Bots',
					icon: workbenchContract.icons.MessageChatbot,
				},
			},
		})

		expect(placement).toMatchObject({
			placement: 'plugin.routes',
			meta: {
				route: {
					path: '/settings',
					navigationLabel: 'Telegram',
					navigationGroup: {
						id: 'bots',
						label: 'Bots',
						icon: 'message-chatbot',
					},
				},
			},
		})
		expect(Object.isFrozen(placement.meta?.route?.navigationGroup)).toBe(true)
		expect(() =>
			workbenchContract.route('/broken', {
				title: 'Broken',
				navigation: { group: { id: '', label: 'Bots' } },
			}),
		).toThrow('navigation.group.id required')
	})

	it('keeps host-only route grouping out of the browser Contract fingerprint', () => {
		const define = (grouped: boolean) =>
			workbenchContract.define({
				views: {
					Manager: {
						placements: [
							workbenchContract.route('/settings', {
								title: 'KOOK Bots',
								icon: workbenchContract.icons.BrandDiscord,
								order: 66,
								navigation: grouped
									? {
											label: 'KOOK',
											group: {
												id: 'bots',
												label: 'Bots',
												icon: workbenchContract.icons.MessageChatbot,
											},
										}
									: undefined,
							}),
						],
					},
				},
			})

		expect(define(true).fingerprint).toBe(define(false).fingerprint)
	})

	it('types server RPC methods as asynchronous browser calls', () => {
		type Rpc = { ping(input: string): string; save(): Promise<number>; localState: string }
		type Client = WorkbenchRpcClient<Rpc>
		expectTypeOf<ReturnType<Client['ping']>>().toEqualTypeOf<Promise<string>>()
		expectTypeOf<ReturnType<Client['save']>>().toEqualTypeOf<Promise<number>>()
		expectTypeOf<Client>().not.toHaveProperty('localState')
	})

	it('exposes exactly the declared UI views', () => {
		const contract = workbenchContract.define({
			views: {
				Overview: {
					placements: [workbenchContract.slot(workbenchContract.slots.PluginTabs)],
				},
			},
		})
		const ui = createWorkbenchUi(contract)
		const Overview = () => null
		const module = ui.define({ Overview })
		expect(module.views).toEqual({ Overview })
		expect(() => ui.define({ Overview: null as never })).toThrow('invalid View export')
	})

	it('does not require browser exports for builtin document Views', () => {
		const contract = workbenchContract.define({
			views: {
				About: workbenchContract.document({
					placements: [workbenchContract.slot(workbenchContract.slots.PluginInfo)],
					content: [] as never,
				}),
			},
		})
		const module = createWorkbenchUi(contract).define({})
		expect(module.views).toEqual({})
	})

	it('produces stable Contract fingerprints and carries them into the UI module', () => {
		const define = () =>
			workbenchContract.define({
				resources: { commands: workbenchContract.rpc<{ ping(): string }>() },
				views: {
					Overview: {
						placements: [workbenchContract.slot(workbenchContract.slots.PluginTabs)],
					},
				},
			})
		const first = define()
		const second = define()
		const changed = workbenchContract.define({
			resources: { commands: workbenchContract.rpc<{ ping(): string }>() },
			views: {
				Overview: {
					placements: [workbenchContract.slot(workbenchContract.slots.PluginInfo)],
				},
			},
		})
		const module = createWorkbenchUi(first).define({ Overview: () => null })
		expect(first.fingerprint).toMatch(/^wbc-/)
		expect(second.fingerprint).toBe(first.fingerprint)
		expect(changed.fingerprint).not.toBe(first.fingerprint)
		expect(module.contractFingerprint).toBe(first.fingerprint)
	})

	it('keeps the optional capability inert when disabled', async () => {
		const runtime = createRuntimeContext({ workbench: false })
		try {
			expect(runtime.ctx.workbench.enabled).toBe(false)
			const extension = workbench.extension({ contract: workbenchContract.define({}) })
			expect(runtime.ctx.workbench.mount(extension, {})).toBeUndefined()
		} finally {
			await runtime.dispose()
		}
	})

	it('replaces a stale mount when HMR creates a new owner Context', async () => {
		const runtime = createRuntimeContext()
		try {
			const extension = workbench.extension({ contract: workbenchContract.define({}) })
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
