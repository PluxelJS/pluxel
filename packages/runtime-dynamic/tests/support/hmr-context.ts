import '../../src/services'
import { afterEach } from 'vitest'
import { createHost, type Host } from '@pluxel/test'
import type { Context } from '@pluxel/core'
import { setPluginsEnabled } from '@pluxel/runtime/services'

export type HmrTestState = {
	enabled?: Set<string>
	runtimeState?: {
		forks?: Record<string, string[]>
		baseProviders?: Record<string, string>
		dependencyOverrides?: Record<string, Record<number, string>>
		builtinsKnown?: Record<string, 1>
	}
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
	state.enabled = enabled
	state.runtimeState ??= {}
	const loaderHmr = { normalizeId: (id: string) => id }
	const host = createHost({ root: { loaderHmr } } as Context.Config)
	const ctx = host.ctx
	const runtimeState = ctx.runtimeState
	const updateRuntimeState = runtimeState.update.bind(runtimeState)
	runtimeState.update = (run) => {
		updateRuntimeState(run)
		syncExternalState(ctx, state)
	}

	runtimeState.update((draft) => {
		setPluginsEnabled(draft, enabled, true)
		const persisted = state.runtimeState ?? {}
		if (persisted.forks) draft.forks = cloneRecordOfArrays(persisted.forks)
		if (persisted.baseProviders) draft.baseProviders = cloneStringRecord(persisted.baseProviders)
		if (persisted.dependencyOverrides) {
			draft.dependencyOverrides = cloneNestedStringRecord(persisted.dependencyOverrides)
		}
		if (persisted.builtinsKnown) draft.builtinsKnown = cloneBuiltinsKnown(persisted.builtinsKnown)
	})
	syncExternalState(ctx, state)

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

function syncExternalState(ctx: Context, state: HmrTestState): void {
	const snapshot = ctx.runtimeState.snapshot()
	const enabled = (state.enabled ??= new Set<string>())
	enabled.clear()
	for (const name of snapshot.enabled) enabled.add(name)

	const runtimeState = (state.runtimeState ??= {})
	runtimeState.forks = cloneRecordOfArrays(snapshot.forks)
	runtimeState.baseProviders = { ...snapshot.baseProviders }
	runtimeState.dependencyOverrides = cloneNestedStringRecord(snapshot.dependencyOverrides)
	runtimeState.builtinsKnown = { ...snapshot.builtinsKnown }
}

function cloneRecordOfArrays(value: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = Object.create(null)
	if (!value || typeof value !== 'object' || Array.isArray(value)) return out
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(raw)) continue
		out[key] = raw.filter((item): item is string => typeof item === 'string')
	}
	return out
}

function cloneStringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = Object.create(null)
	if (!value || typeof value !== 'object' || Array.isArray(value)) return out
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === 'string') out[key] = raw
	}
	return out
}

function cloneNestedStringRecord(value: unknown): Record<string, Record<number, string>> {
	const out: Record<string, Record<number, string>> = Object.create(null)
	if (!value || typeof value !== 'object' || Array.isArray(value)) return out
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
		const entry: Record<number, string> = Object.create(null)
		for (const [index, target] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof target === 'string') entry[Number(index)] = target
		}
		out[key] = entry
	}
	return out
}

function cloneBuiltinsKnown(value: unknown): Record<string, 1> {
	const out: Record<string, 1> = Object.create(null)
	if (!value || typeof value !== 'object' || Array.isArray(value)) return out
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (raw === 1) out[key] = 1
	}
	return out
}
