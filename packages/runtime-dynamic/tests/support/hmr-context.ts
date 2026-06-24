import '../../src/services'
import { afterEach } from 'vitest'
import { createHost, type Host } from '@pluxel/test'
import type { Context } from '@pluxel/core'

export type HmrTestState = {
	enabled?: Set<string>
	extra?: Record<string, unknown>
}

export type HmrTestContext = {
	core: Context
	ctx: Context
	host: Host
	dispose: () => Promise<void>
}

const active = new Set<HmrTestContext>()

afterEach(async () => {
	const pending = [...active]
	active.clear()
	await Promise.all(pending.map((fixture) => fixture.dispose()))
})

export function createHmrTestContext(state: HmrTestState = {}): HmrTestContext {
	const enabled = state.enabled ?? new Set<string>()
	const extra = state.extra ?? Object.create(null)
	state.enabled = enabled
	state.extra = extra
	const loaderHmr = { normalizeId: (id: string) => id }
	const host = createHost({ root: { loaderHmr } } as Context.Config)
	const ctx = host.ctx
	const configService = ctx.configService

	for (const name of enabled) configService.enableInConfig(name)
	for (const [key, value] of Object.entries(extra)) configService.setExtra(key, value)

	const enableInConfig = configService.enableInConfig.bind(configService)
	configService.enableInConfig = (...names: string[]) => {
		enableInConfig(...names)
		for (const name of names) enabled.add(name)
	}

	const disableInConfig = configService.disableInConfig.bind(configService)
	configService.disableInConfig = (...names: string[]) => {
		disableInConfig(...names)
		for (const name of names) enabled.delete(name)
	}

	const setEnabledInConfig = configService.setEnabledInConfig.bind(configService)
	configService.setEnabledInConfig = (name: string, on: boolean) => {
		setEnabledInConfig(name, on)
		if (on) enabled.add(name)
		else enabled.delete(name)
	}

	const replaceEnabledInConfigSet = configService.replaceEnabledInConfigSet.bind(configService)
	configService.replaceEnabledInConfigSet = (names: Iterable<string>) => {
		const next = new Set(names)
		replaceEnabledInConfigSet(next)
		enabled.clear()
		for (const name of next) enabled.add(name)
	}

	const setExtra = configService.setExtra.bind(configService)
	configService.setExtra = (key: string, value: unknown) => {
		setExtra(key, value)
		extra[key] = value
	}

	const fixture: HmrTestContext = {
		core: ctx,
		ctx,
		host,
		dispose: async () => {
			if (!active.delete(fixture)) return
			await host.dispose()
		},
	}
	active.add(fixture)
	return fixture
}
