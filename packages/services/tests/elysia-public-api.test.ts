import { expect, it } from 'vitest'
import * as api from '@pluxel/services/elysia'
import * as node from '@pluxel/services/elysia/node'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { createHost } from '@pluxel/host'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

it('exposes one Elysia application API and keeps dispatcher and carrier machinery internal', async () => {
	expect(Object.keys(api).sort()).toEqual(['ElysiaApp', 'createElysiaHandler', 'elysia'])
	expect(Object.keys(node)).toEqual(['listenElysia'])
	for (const subpath of ['./http', './http/node', './http/vite']) {
		expect(manifest.exports).not.toHaveProperty(subpath)
		expect(manifest.publishConfig.exports).not.toHaveProperty(subpath)
	}
	const host = await createHost({ plugins: [], services: [api.elysia()] })
	try {
		const response = await api.createElysiaHandler(host)(new Request('http://local.test/missing'))
		expect(response.status).toBe(404)
		expect(
			host.ctx.require(ElysiaRuntime).matchesRequest(new Request('http://local.test/missing')),
		).toBe(false)
	} finally {
		await host.close()
	}
})
