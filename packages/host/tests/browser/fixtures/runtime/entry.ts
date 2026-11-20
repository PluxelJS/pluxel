import { createHost } from '@pluxel/host/browser'
import { Provider } from './provider'
import { Consumer } from './consumer'
import { trace } from './trace'

export async function run() {
	const records: { category: readonly string[]; message: string; storage?: unknown }[] = []
	const sinkLifecycle: string[] = []
	const consumer = Consumer.nodeAddress()
	const host = await createHost({
		plugins: [
			{
				plugin: Provider,
			},
			{
				plugin: Consumer,
				autoStart: true,
			},
		],
		coreConfig: {
			zenfs: {},
			logtape: {
				sinks: {
					capture: Object.assign(
						(record: {
							category: readonly string[]
							message: readonly unknown[]
							properties: Readonly<Record<string, unknown>>
						}) => {
							records.push({
								category: [...record.category],
								message: record.message.join(''),
								storage: record.properties.storage,
							})
						},
						{
							async drain() {
								sinkLifecycle.push('drained')
							},
							async [Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose')]() {
								sinkLifecycle.push('disposed')
							},
						},
					),
				},
				loggers: [
					{ category: ['pluxel'], lowestLevel: 'trace', sinks: ['capture'] },
					{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: [] },
				],
			},
		},
	})
	const manager = host.ctx.logging
	const logging = { initial: manager?.state, final: manager?.state }
	try {
		if (!manager) throw new Error('The browser Host did not install configured logging')
		const rootId = manager.resolved.root.id
		host.ctx.logger.info('host prepared')
		const started = await host.start()
		const running = await host.status()
		await host.stopNode(consumer)
		const stopped = await host.status()
		return { started, running, stopped, trace, records, rootId, logging, sinkLifecycle }
	} finally {
		host.ctx.logger.info('host closing')
		await host.close()
		logging.final = manager?.state
	}
}
