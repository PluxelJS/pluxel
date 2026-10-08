import type { PluginHost } from '@pluxel/host'
import { Commands } from '@pluxel/services/commands'
import {
	Observations,
	LauncherControl,
	CliControl,
	encodeJson,
	type Json,
} from '@embedded-launcher/sdk'

/** A borrowed Host controller shared by native embedding and the Vite execution binding. */
export function createControl(host: PluginHost) {
	let closed = false
	let pending = 0
	const command = async (expression: string) => {
		const result = await host.ctx.require(Commands).execute('calculator.calculate', { expression })
		return result.isOk()
			? { ok: true, value: result.value }
			: { ok: false, error: { code: result.error.code, message: result.error.message } }
	}
	async function address(name: unknown) {
		if (typeof name !== 'string') throw new TypeError('plugin must be a rootExportName string')
		const status = await host.status()
		const matches = status.statuses.filter((item) => item.rootExportName === name)
		if (matches.length !== 1) throw new Error(`Unknown or ambiguous plugin: ${name}`)
		return matches[0].address
	}
	async function invoke(method: string, params: Record<string, unknown>) {
		switch (method) {
			case 'host.capabilities':
				return {
					lease: host.ctx.require(LauncherControl).lease,
					...host.ctx.require(Observations).snapshot(),
				}
			case 'host.start':
			case 'host.status':
				return host.status()
			case 'host.stop': {
				const report = await host.stopNode(await address(params.plugin))
				return { status: await host.status(), report }
			}
			case 'host.startNode': {
				const report = await host.startNode(await address(params.plugin))
				return { status: await host.status(), report }
			}
			case 'host.autostart': {
				if (typeof params.autoStart !== 'boolean') throw new TypeError('autoStart must be boolean')
				const report = await host.setAutoStart(await address(params.plugin), params.autoStart)
				return { status: await host.status(), report }
			}
			case 'host.configGet':
				return host.config.get(await address(params.plugin))
			case 'host.config':
				return host.config.patch(
					await address(params.plugin),
					params.patch as Record<string, unknown>,
				)
			case 'host.configReset':
				return host.config.reset(await address(params.plugin))
			case 'command.execute':
				if (typeof params.expression !== 'string')
					throw new TypeError('expression must be a string')
				return command(params.expression)
			case 'cli.execute':
				return host.ctx.require(CliControl).execute(params.argv as string[])
			case 'launcher.query':
				return host.ctx
					.require(LauncherControl)
					.query(params as unknown as { revision: number; text: string; limit: number })
			case 'launcher.action':
				if (typeof params.handle !== 'string') throw new TypeError('handle must be a string')
				return host.ctx.require(LauncherControl).action(params.handle)
			case 'smoke.run': {
				const calculator = await address('Calculator'),
					commands = await address('CalculatorCommands')
				const before = await command('1 / 3')
				if (!before.ok) throw new Error(`Initial command failed: ${JSON.stringify(before)}`)
				const configured = await host.config.patch(calculator, { precision: 3 })
				if (!configured.ok || configured.application !== 'applied')
					throw new Error(`Config not applied: ${JSON.stringify(configured)}`)
				const after = await command('1 / 3')
				await host.stopNode(calculator)
				const stopped = await command('1 + 2')
				if (stopped.ok) throw new Error('Dependent command survived provider stop')
				await host.startNode(calculator)
				await host.startNode(commands)
				const restarted = await command('1 + 2')
				if (!restarted.ok) throw new Error('Dependent command did not restart')
				const reset = await host.config.reset(calculator)
				return { before, configured, after, stopped, restarted, reset, status: await host.status() }
			}
			default:
				throw new Error(`Unknown execution method: ${method}`)
		}
	}
	return {
		async dispatch(text: string): Promise<string> {
			let id: Json = null
			let admitted = false
			try {
				if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
					throw new RangeError('Frame too large')
				const request = JSON.parse(text)
				if (
					!request ||
					request.jsonrpc !== '2.0' ||
					typeof request.method !== 'string' ||
					(!Number.isSafeInteger(request.id) && typeof request.id !== 'string')
				)
					throw new TypeError('Invalid JSON-RPC request')
				id = request.id
				if (closed) throw new Error('Host lease closed')
				if (pending >= 64) throw new Error('Execution request limit reached')
				if (
					request.params !== undefined &&
					(!request.params || typeof request.params !== 'object' || Array.isArray(request.params))
				)
					throw new TypeError('params must be an object')
				pending++
				admitted = true
				return encodeJson({
					jsonrpc: '2.0',
					id,
					result: await invoke(request.method, request.params ?? {}),
				})
			} catch (error) {
				return encodeJson({
					jsonrpc: '2.0',
					id,
					error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
				})
			} finally {
				if (admitted) pending--
			}
		},
		close() {
			closed = true
		},
	}
}
