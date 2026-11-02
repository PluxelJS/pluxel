import type { CoreHostConfig } from '@pluxel/core'
import { type HostConfigStoreOptions } from './config-store'
import { coercePluginConfigRecords, mergeRecord } from './config-records'
import { assertHostStoreStorage } from './document-storage'
import { declaredConfigBindings } from './input-binding-contract'
import { resolveHostStateDeclaration, type HostStateStoreOptions } from './state-store'

/** Fixed facilities, persisted declarations and runtime-only overrides for one Host. */
export type HostRuntimeOptions = Readonly<
	Omit<CoreHostConfig, 'name'> & {
		state?: HostStateStoreOptions
		configRecords?: HostConfigStoreOptions
	}
>

function fields(input: unknown, allowed: readonly string[], label: string): void {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError(`[host] ${label} must be an object`)
	for (const key of Object.keys(input))
		if (!allowed.includes(key)) throw new TypeError(`[host] ${label} includes unsupported "${key}"`)
	if ('override' in input && input.override !== undefined && typeof input.override !== 'boolean')
		throw new TypeError(`[host] ${label}.override must be a boolean`)
}

/** Capture declaration containers before IO; borrowed capabilities and schema identities are retained. */
export function snapshotHostRuntime(input: HostRuntimeOptions = {}): HostRuntimeOptions {
	fields(
		input,
		['zenfs', 'logtape', 'events', 'plugins', 'tinybase', 'state', 'configRecords'],
		'runtime',
	)
	const state = input.state
	if (state !== undefined) {
		fields(
			state,
			[
				'autoStart',
				'forks',
				'providerDefaults',
				'dependencyOverrides',
				'override',
				'mode',
				'storage',
			],
			'runtime.state',
		)
		assertHostStoreStorage(state)
	}
	const config = input.configRecords
	if (config !== undefined) {
		fields(
			config,
			['records', 'override', 'mode', 'storage', 'overlays', 'declarationSources'],
			'runtime.configRecords',
		)
		assertHostStoreStorage(config)
	}
	return {
		...input,
		...(state === undefined
			? {}
			: {
					state: {
						...state,
						...resolveHostStateDeclaration({
							autoStart: state.autoStart,
							forks: state.forks,
							providerDefaults: state.providerDefaults,
							dependencyOverrides: state.dependencyOverrides,
						}),
					},
				}),
		...(config === undefined
			? {}
			: {
					configRecords: {
						...config,
						records: coercePluginConfigRecords(config.records ?? []).map(
							({ owner, config: record }) => ({
								owner,
								config: mergeRecord(undefined, record),
							}),
						),
						...(config.overlays
							? {
									overlays: config.overlays.map((record) =>
										bindingSnapshot(record, {
											...record,
											config: mergeRecord(undefined, record.config),
											sources: record.sources.map((source) => ({
												...source,
												path: [...source.path],
											})),
										}),
									),
								}
							: {}),
						...(config.declarationSources
							? {
									declarationSources: config.declarationSources.map((source) =>
										bindingSnapshot(source, { ...source, path: [...source.path] }),
									),
								}
							: {}),
					},
				}),
	}
}

function bindingSnapshot<T extends object>(source: T, snapshot: T): T {
	if (declaredConfigBindings.has(source)) declaredConfigBindings.add(snapshot)
	return snapshot
}
