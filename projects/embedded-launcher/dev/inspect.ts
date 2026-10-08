import { defineDevConsole } from '@pluxel/host-vite/console'
import { Commands } from '@pluxel/services/commands'
import { LauncherControl } from '@embedded-launcher/sdk'

export default defineDevConsole(async (dev) => ({
	plugins: await dev.plugins.list(),
	update: await dev.updates.latest(),
}))

export const calculate = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected an expression string')
	const result = await dev.ctx
		.require(Commands)
		.execute('calculator.calculate', { expression: dev.input })
	return result.isOk()
		? { ok: true, value: result.value, update: await dev.updates.latest() }
		: { ok: false, error: { code: result.error.code, message: result.error.message } }
})

export const configure = defineDevConsole(async (dev) => {
	const precision = dev.input
	if (typeof precision !== 'number') throw new TypeError('Expected numeric precision')
	const plugins = await dev.plugins.list()
	const calculator = plugins.find((plugin) => plugin.rootExportName === 'Calculator')
	if (!calculator) throw new Error('Calculator is unavailable')
	const result = await dev.config.patch(calculator.address, { precision })
	return { result, current: await dev.config.get(calculator.address) }
})

export const stop = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected plugin root export name')
	const plugins = await dev.plugins.list()
	const plugin = plugins.find((item) => item.rootExportName === dev.input)
	if (!plugin) throw new Error('Plugin unavailable')
	return {
		report: await dev.plugins.stop(plugin.address),
		current: await dev.plugins.status(plugin.address),
	}
})

export const start = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected plugin root export name')
	const plugins = await dev.plugins.list()
	const plugin = plugins.find((item) => item.rootExportName === dev.input)
	if (!plugin) throw new Error('Plugin unavailable')
	return {
		report: await dev.plugins.start(plugin.address),
		current: await dev.plugins.status(plugin.address),
	}
})

export const query = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected query text')
	return dev.ctx
		.require(LauncherControl)
		.query({ revision: Date.now(), text: dev.input, limit: 10 })
})

export const action = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected action handle')
	return dev.ctx.require(LauncherControl).action(dev.input)
})
