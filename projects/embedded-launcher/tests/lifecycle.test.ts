import * as plugins from '../src/plugins'
import { expect, it } from 'vitest'
import { createTestHost } from '@pluxel/test'
import { BasePlugin, Plugin } from '@pluxel/core'
import { Commands, commands } from '@pluxel/services/commands'
import { defineCommand, Result } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import { Native, nativeServices } from '@embedded-launcher/sdk'
import { Calculator } from '../src/plugins/calculator'

@Plugin()
class Probe extends BasePlugin {
	constructor(readonly calculator: Calculator) {
		super()
	}
	readonly native = this.ctx.require(Native)
	readonly registration = this.ctx.require(Commands).register(
		defineCommand({
			name: 'probe',
			description: 'lifecycle regression',
			input: obj({ text: Type.String() }),
			execute: async ({ text }) => Result.ok(await this.native.echo(text)),
		}),
	)
}

it('invalidates retained owner Service, dependency facade and command registration permanently', async () => {
	let requests = 0
	await using host = await createTestHost({
		services: [
			commands(),
			nativeServices({
				async request(_method, params) {
					requests++
					return params
				},
			}),
		],
	})
	await host.start(Calculator)
	const probe = await host.start(Probe)
	const native = probe.native
	const registration = probe.registration
	const calculator = probe.calculator
	const first = await registration.execute({ text: 'first' })
	expect(first.isOk()).toBe(true)
	expect(calculator.calculate('1+2').text).toBe('3')
	await host.stop(Probe)
	const before = requests
	await expect(native.echo('stale')).rejects.toThrow(/stopped/)
	const stale = await registration.execute({ text: 'stale' })
	expect(stale.isErr()).toBe(true)
	expect(() => calculator.calculate('2+2')).toThrow(/stopped/)
	const replacement = await host.start(Probe)
	const fresh = await replacement.registration.execute({ text: 'fresh' })
	expect(fresh.isOk()).toBe(true)
	const stillStale = await registration.execute({ text: 'still stale' })
	expect(stillStale.isErr()).toBe(true)
	expect(requests).toBe(before + 1)
})

it('uses bounded numeric AST and updates precision through Host config', async () => {
	await using host = await createTestHost()
	const calculator = await host.start(Calculator)
	expect(calculator.calculate('sqrt(9)+2*4').text).toBe('11')
	for (const expression of ['x=1', 'a.b', '[1,2]', '1/0', 'f(x)=x'])
		expect(() => calculator.calculate(expression)).toThrow(
			/Unsupported expression node|finite number/,
		)
	expect(await host.config.patch(Calculator, { precision: 3 })).toMatchObject({
		ok: true,
		application: 'applied',
	})
	expect(calculator.calculate('1/3').text).toBe('0.333')
	expect(await host.config.patch(Calculator, { precision: 10 })).toMatchObject({
		ok: true,
		application: 'applied',
	})
	expect(calculator.calculate('1/3').precision).toBe(10)
})

it('execution close stops admission and waits for accepted native work', async () => {
	const { createSession } = await import('../src/execution/session')
	let release!: () => void
	let entered!: () => void
	const received = new Promise<void>((resolve) => {
		entered = resolve
	})
	const blocked = new Promise<void>((resolve) => {
		release = resolve
	})
	const session = createSession(
		{
			async request(method, params) {
				if (method !== 'native.echo') return { accepted: true }
				entered()
				await blocked
				return params
			},
		},
		undefined,
		Object.values(plugins),
	)
	const rpc = (id: number, method: string, params = {}) =>
		session.dispatch(JSON.stringify({ jsonrpc: '2.0', id, method, params })).then(JSON.parse)
	const starts = await Promise.all([rpc(1, 'host.start'), rpc(2, 'host.start')])
	expect(starts.every((result) => result.result.summary.running === 6)).toBe(true)
	const invocation = rpc(3, 'command.execute', { expression: '2+2' })
	await received
	let closed = false
	const closure = session.close().then((): undefined => {
		closed = true
		return undefined
	})
	await Promise.resolve()
	expect(closed).toBe(false)
	expect(await rpc(4, 'host.status')).toMatchObject({
		error: { message: 'Execution session closed' },
	})
	release()
	await invocation
	await closure
	await session.close()
	expect(closed).toBe(true)
})
