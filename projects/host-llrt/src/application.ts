import {
	inspectHost,
	probeEnvironment,
	probePlugins,
} from '@pluxel-example/host-targets-plugins/probe'
import { createScriptScope, ScriptError } from '@pluxel/agent-sdk/host'
import { formatPluginNodeReference, parsePluginNodeReference } from '@pluxel/core'
import { readPluginLogIdentity } from '@pluxel/core/logger'
import { defineHostService, installScopeService, type HostService } from '@pluxel/host/application'
import { startHost } from '@pluxel/host/embedded'

const ticketAddress = parsePluginNodeReference('package:@pluxel-example/host-llrt::TicketDesk')
const runtime = crypto.randomUUID()
type TicketModule = typeof import('./index')

export async function run(
	sourceUrl: string,
	issue: (name: string) => string,
	installedEntry: string | null,
	pid: number,
) {
	// Rust selects a local file on every VM boot. Only the type is known at host build time.
	const ticket: TicketModule | undefined = installedEntry ? await import(installedEntry) : undefined
	const plugins = [...probePlugins(sourceUrl)]
	const services: HostService[] = []
	if (ticket) {
		plugins.push({ plugin: ticket.TicketDesk, autoStart: true })
		services.push(
			defineHostService({
				name: 'Rust ticket printer',
				provides: [installScopeService(ticket.TicketPrinter, { create: () => ({ issue }) })],
			}),
		)
	}
	let logOwner: string | undefined
	await using host = await startHost(
		() => ({
			plugins,
			services,
			coreConfig: {
				vault: { backend: 'encrypted' },
				http: { allowedOrigins: [new URL(sourceUrl).origin] },
				logtape: {
					sinks: {
						receipt(record) {
							const owner = readPluginLogIdentity(record.category)
							if (owner && record.level === 'info' && record.properties.operation === 'host-probe')
								logOwner = formatPluginNodeReference(owner.node)
						},
					},
					loggers: [
						{ category: ['pluxel', 'plugins'], sinks: ['receipt'], lowestLevel: 'info' },
						{ category: ['logtape', 'meta'], sinks: ['receipt'], lowestLevel: 'warning' },
					],
				},
			},
		}),
		{ env: probeEnvironment },
	)
	await using scope = createScriptScope({ ctx: host.ctx })
	const shared = await inspectHost(scope.sdk, { sourceUrl, expectedSource: 'Rust loopback' })
	if (logOwner !== shared.capabilities.owner) throw new Error('Missing the probe owner’s info log')
	if (ticket) {
		const { instance } = await scope.sdk.plugin(ticket.TicketDesk.nodeAddress()).instance()
		const tickets = [instance.print(), instance.print()]
		const encryptedVault = await instance.checkReceiptStorage(tickets[1])
		return JSON.stringify({ pid, runtime, shared, logOwner, ticket: { tickets, encryptedVault } })
	}
	try {
		await scope.sdk.plugin(ticketAddress).context()
	} catch (error) {
		if (error instanceof ScriptError && error.code === 'target_unavailable')
			return JSON.stringify({ pid, runtime, shared, logOwner, ticket: error.code })
		throw error
	}
	throw new Error('Uninstalled TicketDesk is still available')
}
