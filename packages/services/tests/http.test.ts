import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import { createHost } from '@pluxel/host'
import { expect, it } from 'vitest'
import { Http, HttpServer, http } from '../src/http'

@Plugin()
class Routes extends BasePlugin {
	init() {
		this.ctx.require(Http).get('/hello', () => 'hello')
	}
}
@Plugin()
class ConflictingRoutes extends BasePlugin {
	init() {
		this.ctx.require(Http).get('/hello', () => 'conflict')
	}
}

it('publishes and withdraws business routes through the standalone Host commit without management', async () => {
	const host = await createHost({ plugins: [Routes, ConflictingRoutes], services: [http()] })
	try {
		const server = resolveContextCapability(host.ctx, HttpServer)
		const request = () => new Request('http://localhost/hello')
		const absent = await server.fetch(request())
		expect(absent.status).toBe(404)
		await host.startNode(pluginNodeAddressOf(Routes))
		const published = await server.fetch(request())
		expect(await published.text()).toBe('hello')
		await host.startNode(pluginNodeAddressOf(ConflictingRoutes))
		const conflict = await server.fetch(request())
		expect(await conflict.text()).toBe('hello')
		expect('adminAccess' in host.ctx).toBe(false)
		expect('workbench' in host.ctx).toBe(false)
		await host.stopNode(pluginNodeAddressOf(ConflictingRoutes))
		await host.stopNode(pluginNodeAddressOf(Routes))
		const withdrawn = await server.fetch(request())
		expect(withdrawn.status).toBe(404)
	} finally {
		await host.close()
	}
})
