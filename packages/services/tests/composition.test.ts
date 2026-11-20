import { BasePlugin, Plugin } from '@pluxel/core'
import { installOwnerViewService } from '@pluxel/core/host'
import { createHost, defineHostService } from '@pluxel/host'
import { Commands } from '@pluxel/services/commands'
import { createElysiaHandler, ElysiaApp } from '@pluxel/services/elysia'
import { servicesPreset } from '@pluxel/services/preset'
import { expect, it } from 'vitest'

export abstract class Greeting {
	abstract message(): string
}

@Plugin()
class Greeter extends BasePlugin {
	init() {
		const greeting = this.ctx.service(Greeting)
		this.ctx.service(ElysiaApp).get('/greeting', () => greeting.message())
	}
}

it('runs a custom service and Management commands with the Workbench disabled', async () => {
	const greeting = defineHostService({
		name: 'Greeting',
		provides: [
			installOwnerViewService(Greeting, {
				createRoot: () => ({}),
				createView: (_root, owner) => ({
					message: () => `Hello from ${owner.pluginInfo?.displayName}`,
				}),
			}),
		],
	})
	const services = await servicesPreset(
		{ root: process.cwd(), mode: 'test', env: {}, bindings: {} },
		{ workbench: false },
	)
	await using host = await createHost({
		plugins: [{ plugin: Greeter, autoStart: true }],
		services: [greeting, ...services.toReversed()],
	})
	await host.start()
	const fetch = createElysiaHandler(host)
	const response = await fetch(new Request('http://local.test/greeting'))
	expect(await response.text()).toBe('Hello from Greeter')
	const list = await host.ctx.service(Commands).execute('plugin.list', {})
	expect(list.unwrap()).toMatchObject({
		plugins: [{ address: Greeter.nodeAddress(), lifecycleState: 'running' }],
	})
	const session = await fetch(new Request('http://local.test/__pluxel/runtime/session'))
	expect(session.status).toBe(400)
	await session.body?.cancel()
	const shell = await fetch(
		new Request('http://local.test/__pluxel/workbench', {
			headers: { accept: 'text/html' },
		}),
	)
	expect(shell.status).toBe(404)
	await shell.body?.cancel()
})
