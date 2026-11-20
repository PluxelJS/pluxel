import type { CoreFacilitiesConfig } from './Context'
import { snapshotFsConfig, type ResolvedFsConfig } from '../fs/config'
import { resolveLogTapeConfig, type ResolvedLogTapeConfig } from '../logging/config'
import type { EventsServiceConfig } from '../services/events/EventsService'
import { resolveTinyBaseOptions } from '../tinybase/options'
import type { TinyBaseOptions } from '../tinybase/types'
import { snapshotVaultConfig } from '../vault/options'
import type { VaultServiceConfig } from '../vault/types'
import { assertCoreConfigObject } from './core-config-object'
import { snapshotOutboundHttpOptions, type ResolvedOutboundHttpOptions } from '../http/options'

const facilityFields = new Set(['logtape', 'zenfs', 'tinybase', 'vault', 'events', 'http'])
const eventFields = new Set([
	'events',
	'catchPromiseError',
	'checkSyncFuncReturnPromise',
	'errorPolicy',
])

function snapshotEvents(config: EventsServiceConfig | undefined): EventsServiceConfig | undefined {
	if (config === undefined) return undefined
	assertCoreConfigObject(config, '[core.events] options', eventFields)
	const { events, errorPolicy, catchPromiseError, checkSyncFuncReturnPromise } = config
	if (
		events !== undefined &&
		(!Array.isArray(events) ||
			events.some((event) => !['string', 'number', 'symbol'].includes(typeof event)))
	)
		throw new TypeError('[core.events] events must be an array of event keys')
	if (errorPolicy !== undefined && !['silent', 'log', 'throw'].includes(errorPolicy))
		throw new TypeError('[core.events] errorPolicy must be silent, log or throw')
	if (catchPromiseError !== undefined && typeof catchPromiseError !== 'boolean')
		throw new TypeError('[core.events] catchPromiseError must be a boolean')
	if (checkSyncFuncReturnPromise !== undefined && typeof checkSyncFuncReturnPromise !== 'boolean')
		throw new TypeError('[core.events] checkSyncFuncReturnPromise must be a boolean')
	return Object.freeze({
		...config,
		...(events === undefined ? {} : { events: Object.freeze([...events]) }),
	})
}

type ResolvedCoreFacilitiesConfig = Readonly<{
	logtape?: ResolvedLogTapeConfig
	events?: EventsServiceConfig
	zenfs: ResolvedFsConfig
	tinybase: Required<TinyBaseOptions>
	vault: Readonly<VaultServiceConfig>
	http: ResolvedOutboundHttpOptions
}>

const snapshots = new WeakSet<CoreFacilitiesConfig>()

/** Validate and capture fixed Core inputs without opening backends or invoking factories. */
export function snapshotCoreFacilitiesConfig(
	input: CoreFacilitiesConfig = {},
): ResolvedCoreFacilitiesConfig {
	if (snapshots.has(input)) return input as ResolvedCoreFacilitiesConfig
	assertCoreConfigObject(input, '[core] facilities', facilityFields)
	const snapshot = Object.freeze({
		logtape: resolveLogTapeConfig(input.logtape),
		events: snapshotEvents(input.events),
		zenfs: snapshotFsConfig(input.zenfs === undefined ? {} : input.zenfs),
		tinybase: resolveTinyBaseOptions(input.tinybase),
		vault: snapshotVaultConfig(input.vault),
		http: snapshotOutboundHttpOptions(input.http),
	})
	snapshots.add(snapshot)
	return snapshot
}
