import { request } from 'launcher:bridge'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { Commands, commands } from '@pluxel/services/commands'
import { defineCommand, Result, type CommandRegistration } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import { Native, nativeServices, encodeJson, type NativeApi } from '@embedded-launcher/sdk'
import { Calculator } from '../../src/plugins/calculator'

let captured: {
	native: NativeApi
	calculator: Calculator
	registration: CommandRegistration<{ text: string }, string>
}
@Plugin()
export class EmbeddedLifecycleProbe extends BasePlugin {
	constructor(private readonly calculator: Calculator) {
		super()
	}
	protected override init() {
		const native = this.ctx.require(Native)
		const registration = this.ctx.require(Commands).register(
			defineCommand({
				name: 'fixture.echo',
				description: 'Real embedded lifecycle acceptance',
				input: obj({ text: Type.String() }),
				execute: async ({ text }) => Result.ok(await native.echo(text)),
			}),
		)
		captured = { native, calculator: this.calculator, registration }
	}
}
let id = 0
let host: Awaited<ReturnType<typeof createHost>> | undefined
export async function dispatch(_text: string): Promise<string> {
	if (host) throw new Error('Lifecycle fixture must run once per runtime')
	host = await createHost({
		plugins: [Calculator, EmbeddedLifecycleProbe],
		services: [
			commands(),
			nativeServices({
				async request(method, params) {
					const identity = ++id
					const reply = JSON.parse(
						await request(encodeJson({ jsonrpc: '2.0', id: identity, method, params })),
					)
					if (reply.error) throw new Error(reply.error.message)
					if (reply.id !== identity) throw new Error('Native response identity mismatch')
					return reply.result
				},
			}),
		],
	})
	await host.startNode(pluginNodeAddressOf(EmbeddedLifecycleProbe))
	const old = captured!
	const initial = await old.registration.execute({ text: 'before-stop' })
	if (!initial.isOk()) throw new Error('Initial native roundtrip failed')
	if (old.calculator.calculate('1+2').text !== '3') throw new Error('Dependency not injected')
	await host.stopNode(pluginNodeAddressOf(EmbeddedLifecycleProbe))
	let nativeRejected = false,
		facadeRejected = false
	try {
		await old.native.echo('stale')
	} catch {
		nativeRejected = true
	}
	try {
		old.calculator.calculate('1+2')
	} catch {
		facadeRejected = true
	}
	const stale = await old.registration.execute({ text: 'stale' })
	const commandRejected = stale.isErr()
	await host.startNode(pluginNodeAddressOf(EmbeddedLifecycleProbe))
	const fresh = await captured!.registration.execute({ text: 'after-restart' })
	const freshWorks = fresh.isOk()
	const stillStale = await old.registration.execute({ text: 'same-name-stale' })
	const oldStillRejected = stillStale.isErr()
	const result = { nativeRejected, facadeRejected, commandRejected, freshWorks, oldStillRejected }
	if (Object.values(result).some((value) => !value))
		throw new Error(`Lifecycle fixture failed: ${JSON.stringify(result)}`)
	return encodeJson({ jsonrpc: '2.0', id: 1, result })
}
export async function close() {
	await host?.close()
}
