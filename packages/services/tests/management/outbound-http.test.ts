import { BasePlugin, formatPluginNodeReference, Plugin } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { OUTBOUND_HTTP_LOG_STREAM_ID, type RuntimeLogEvent } from '@pluxel/core/logging/protocol'
import { createHost } from '@pluxel/host'
import { RpcStub } from 'capnweb'
import { expect, it, vi } from 'vitest'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'

@Plugin({ forkable: true })
class OutboundWorker extends BasePlugin {
	read(url: string) {
		return this.ctx.wretch.get(url).text()
	}
}

it('controls an addressed Wretch caller through Management and removes settings with its fork', async () => {
	const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		return new Response(request.headers.get('accept-language'))
	})
	await using host = await createHost({
		plugins: [{ plugin: OutboundWorker }],
		coreConfig: {
			http: { fetch: transport, allowedOrigins: ['https://outbound.test'] },
		},
		services: [managementAccess(), management()],
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const streamId = OUTBOUND_HTTP_LOG_STREAM_ID
	await expect(client.logs.streams()).resolves.toMatchObject({
		streams: [{ streamId, count: 0, retention: { windowLines: 5_000 } }],
	})
	const fork = OutboundWorker.nodeAddress('regional')
	expect(await client.forks.ensure({ fork })).toMatchObject({ ok: true })
	await host.startNode(fork)
	const plugin = requirePluginService(host.ctx).getInstance(fork) as OutboundWorker
	const events: RuntimeLogEvent[] = []
	using _subscription = await client.logs.follow(
		{ streamId, filter: { plugin: fork } },
		(event) => {
			events.push(event)
		},
	)

	const initial = await client.outboundHttp.get(fork)
	const localized = await client.outboundHttp.save(fork, initial.revision, {
		headers: { 'accept-language': 'zh-Hant' },
	})
	await expect(plugin.read('https://outbound.test/receipt?token=not-for-logs')).resolves.toBe(
		'zh-Hant',
	)
	expect(await client.outboundHttp.get(null)).toMatchObject({
		activity: [{ owner: fork, lastOrigin: 'https://outbound.test', received: 1, lastStatus: 200 }],
	})
	const denied = await client.outboundHttp.save(fork, localized.snapshot.revision, {
		allowedOrigins: [],
	})
	await expect(plugin.read('https://outbound.test/receipt')).rejects.toThrow(
		'Outbound HTTP origin is not allowed',
	)
	expect(transport).toHaveBeenCalledOnce()
	expect(await client.outboundHttp.get(fork)).toMatchObject({
		activity: [{ owner: fork, denied: 1, lastOutcome: 'denied' }],
	})
	const lines = () => events.flatMap((event) => (event.type === 'append' ? event.lines : []))
	await vi.waitFor(() =>
		expect(lines()).toMatchObject([
			{
				plugin: fork,
				props: { method: 'GET', origin: 'https://outbound.test', outcome: 'response', status: 200 },
			},
			{
				plugin: fork,
				props: {
					method: 'GET',
					origin: 'https://outbound.test',
					outcome: 'denied',
					code: 'origin_denied',
				},
			},
		]),
	)
	const meta = await client.logs.meta(streamId)
	const retained = await client.logs.range(streamId, {
		epoch: meta.epoch,
		fromSeq: meta.headSeq,
		filter: { plugin: fork },
	})
	expect(retained).toMatchObject({ ok: true, lines: lines() })
	expect(JSON.stringify(retained)).not.toMatch(/\/receipt|not-for-logs/)
	const defaultNode = OutboundWorker.nodeAddress()
	await host.startNode(defaultNode)
	const defaultPlugin = requirePluginService(host.ctx).getInstance(defaultNode) as OutboundWorker
	await defaultPlugin.read('https://outbound.test/')
	const all = await client.outboundHttp.get(null)
	expect(all.activity.map(({ owner: address }) => formatPluginNodeReference(address))).toEqual(
		[defaultNode, fork].map(formatPluginNodeReference),
	)
	await expect(client.logs.meta(streamId)).resolves.toHaveProperty('count', 3)
	expect(lines()).toHaveLength(2)

	expect(await client.forks.remove(fork)).toMatchObject({ ok: true, status: 'removed' })
	await expect(
		client.outboundHttp.save(fork, denied.snapshot.revision, { timeoutMs: 900 }),
	).rejects.toThrow(/unavailable/)
	expect(await client.forks.ensure({ fork })).toMatchObject({ ok: true })
	await expect(client.outboundHttp.get(fork)).resolves.toHaveProperty('settings', {})
})
