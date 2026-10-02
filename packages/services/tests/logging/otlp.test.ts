import { getOpenTelemetrySink } from '@logtape/otel'
import { OTLPLogExporter as HttpLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPLogExporter as ProtobufLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
	BatchLogRecordProcessor,
	LoggerProvider,
	type ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostService } from '@pluxel/host'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { logging, type RuntimeLoggingInput } from '../../src/logging/index'

@Plugin()
class RemoteLoggedOwner extends BasePlugin {
	init() {
		this.ctx.logger.info('plugin started', { orderId: 'order-42' })
		return () => this.ctx.logger.info('plugin stopped')
	}
}

function plan(sink: ReturnType<typeof getOpenTelemetrySink>): RuntimeLoggingInput {
	return {
		root: { profile: 'otlp-test' },
		sinks: {
			remote: { kind: 'logtape', label: 'OTLP', sink, caller: false },
			memory: { kind: 'store', caller: false },
		},
		routes: {
			runtime: [
				{ sink: 'remote', minLevel: 'info' },
				{ sink: 'memory', minLevel: 'info' },
			],
			plugins: [{ sink: 'remote', minLevel: 'trace' }],
			debug: [],
			meta: [{ sink: 'memory', minLevel: 'warning' }],
		},
	}
}

it.each([
	['http/json', HttpLogExporter, 'application/json'],
	['http/protobuf', ProtobufLogExporter, 'application/x-protobuf'],
] as const)(
	'exports native records over %s and drains plugin shutdown logs on Host close',
	async (_protocol, Exporter, contentType) => {
		const requests: {
			url: string | undefined
			contentType: string | undefined
			auth: string | undefined
			body: Buffer
		}[] = []
		const server = createServer(async (req, res) => {
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(Buffer.from(chunk))
			requests.push({
				url: req.url,
				contentType: req.headers['content-type'],
				auth: req.headers.authorization,
				body: Buffer.concat(chunks),
			})
			res.writeHead(200, { 'content-type': contentType })
			res.end(contentType === 'application/json' ? '{}' : undefined)
		})
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
		const records: ReadableLogRecord[] = []
		const provider = new LoggerProvider({
			resource: resourceFromAttributes({ 'service.name': 'pluxel-otlp-test' }),
			processors: [
				{
					onEmit(record) {
						records.push(record)
					},
					async forceFlush() {},
					async shutdown() {},
				},
				new BatchLogRecordProcessor({
					exporter: new Exporter({
						url: `http://127.0.0.1:${address.port}/insert/opentelemetry/v1/logs`,
						headers: { authorization: 'Bearer fixture' },
					}),
					scheduledDelayMillis: 60_000,
				}),
			],
		})
		const shutdown = vi.spyOn(provider, 'shutdown')
		const sink = getOpenTelemetrySink({ loggerProvider: provider })
		try {
			const host = await createHost({
				plugins: [RemoteLoggedOwner],
				services: [logging(plan(sink))],
			})
			try {
				await host.startNode(pluginNodeAddressOf(RemoteLoggedOwner))
				host.ctx.logger.debug('filtered runtime debug')
				host.ctx.logger.error('remote failure', { error: new Error('fixture failure') })
				expect(requests).toHaveLength(0)
			} finally {
				await host.close()
			}
			expect(shutdown).toHaveBeenCalledTimes(1)
			expect(requests).toHaveLength(1)
			expect(requests[0]).toMatchObject({
				url: '/insert/opentelemetry/v1/logs',
				contentType,
				auth: 'Bearer fixture',
			})
			// Both OTLP encodings retain these strings on the wire.
			expect(requests[0]!.body.toString()).toContain('plugin stopped')
			expect(requests[0]!.body.toString()).toContain('pluxel-otlp-test')
			expect(records.some((r) => r.body === 'filtered runtime debug')).toBe(false)
			expect(records.find((r) => r.body === 'plugin started')?.attributes).toMatchObject({
				orderId: 'order-42',
				category: expect.arrayContaining(['pluxel', 'plugins']),
			})
			expect(records.find((r) => r.body === 'remote failure')?.attributes).toMatchObject({
				'exception.message': 'fixture failure',
				'exception.stacktrace': expect.stringContaining('Error: fixture failure'),
			})
		} finally {
			if (shutdown.mock.calls.length === 0) await provider.shutdown()
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		}
	},
)

it('disposes the native sink once when a later Host service fails to prepare', async () => {
	const provider = new LoggerProvider()
	const shutdown = vi.spyOn(provider, 'shutdown')
	const sink = getOpenTelemetrySink({ loggerProvider: provider })
	try {
		await expect(
			createHost({
				plugins: [],
				services: [
					logging(plan(sink)),
					defineHostService({
						name: 'FailAfterLogging',
						capabilities: [],
						prepare() {
							throw new Error('fixture prepare failed')
						},
					}),
				],
			}),
		).rejects.toThrow('fixture prepare failed')
		expect(shutdown).toHaveBeenCalledTimes(1)
	} finally {
		if (shutdown.mock.calls.length === 0) await provider.shutdown()
	}
})
