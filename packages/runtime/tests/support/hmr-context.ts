import { Context, type Context as PlxContext } from '@pluxel/core'

export type HmrTestState = {
	enabled?: Set<string>
	extra?: Record<string, unknown>
}

export type HmrTestContext = {
	core: Context
	ctx: PlxContext
}

export function createHmrTestContext(state: HmrTestState = {}): HmrTestContext {
	const core = new Context()
	const enabled = state.enabled ?? new Set<string>()
	const extra = state.extra ?? Object.create(null)
	const loaderHmr = { normalizeId: (id: string) => id }
	const root = { loaderHmr }
	const configService = {
		isReady: true,
		ready: Promise.resolve(),
		isEnabledInConfig(name: string) {
			return enabled.has(name)
		},
		setEnabledInConfig(name: string, on: boolean) {
			if (on) enabled.add(name)
			else enabled.delete(name)
		},
		enableInConfig(...names: string[]) {
			for (const n of names) enabled.add(n)
		},
		disableInConfig(...names: string[]) {
			for (const n of names) enabled.delete(n)
		},
		getRawConfig(_name: string) {
			return {}
		},
		getConfigRevision() {
			return 0
		},
		ensureValidated() {
			return Promise.resolve({})
		},
		patchConfig: () => {},
		getExtra<T = unknown>(key: string): T | undefined {
			return extra[key] as T | undefined
		},
		setExtra(key: string, value: unknown) {
			extra[key] = value
		},
		batch(run: () => void) {
			run()
		},
	}

	const ctx = {
		root,
		registry: core.registry,
		events: core.events,
		internalEvent: core.internalEvent,
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		configService,
	} as unknown as PlxContext

	return { core, ctx }
}
