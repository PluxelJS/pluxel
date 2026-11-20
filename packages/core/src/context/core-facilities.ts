import type { CoreFacilitiesConfig, RootContext } from './Context'
import type { LoggerServiceConfig } from '../logger/LoggerService'
import { resolveLogTapeConfig, type ResolvedLogTapeConfig } from '../logging/config'
import type { EventsServiceConfig } from '../services/events/EventsService'
import { resolveTinyBaseOptions } from '../tinybase/options'
import type { TinyBaseOptions } from '../tinybase/types'
import { snapshotVaultConfig } from '../vault/options'
import type { VaultServiceConfig } from '../vault/types'
import { assertCoreConfigObject } from './core-config-object'
import {
	snapshotOutboundHttpOptions,
	type ProxyDispatcherFactory,
	type ResolvedOutboundHttpOptions,
} from '../http/options'
import type { CoreStorage } from '../storage/documents'
import { createMemoryStorage } from '../storage/memory'

const facilityFields = new Set(['logtape', 'zenfs', 'tinybase', 'vault', 'events', 'http'])
const requestFacilityFields = new Set(['tinybase', 'vault', 'events', 'http'])
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

type CoreStorageFactory = (root: RootContext) => CoreStorage

export type PreparedCoreFacilities = Readonly<{
	logtape?: ResolvedLogTapeConfig
	events?: EventsServiceConfig
	tinybase: Required<TinyBaseOptions>
	createStorage: CoreStorageFactory
	createLoggerConfig?: () => LoggerServiceConfig
	vault: Readonly<VaultServiceConfig>
	http: ResolvedOutboundHttpOptions
}>

const snapshots = new WeakSet<PreparedCoreFacilities>()

function prepareFacilities(
	input: CoreFacilitiesConfig,
	resolved: Pick<PreparedCoreFacilities, 'createStorage' | 'createLoggerConfig' | 'vault' | 'http'>,
): PreparedCoreFacilities {
	const snapshot = Object.freeze({
		logtape: resolveLogTapeConfig(input.logtape),
		events: snapshotEvents(input.events),
		tinybase: resolveTinyBaseOptions(input.tinybase),
		...resolved,
	})
	snapshots.add(snapshot)
	return snapshot
}

/** Validate and capture fixed Core inputs without opening backends or invoking factories. */
export function snapshotCoreFacilities(
	input: CoreFacilitiesConfig,
	prepareStorage: (input: CoreFacilitiesConfig['zenfs']) => CoreStorageFactory,
	createProxyDispatcher: ProxyDispatcherFactory | undefined,
): PreparedCoreFacilities {
	assertCoreConfigObject(input, '[core] facilities', facilityFields)
	return prepareFacilities(input, {
		createStorage: prepareStorage(input.zenfs),
		vault: snapshotVaultConfig(input.vault),
		http: snapshotOutboundHttpOptions(input.http, { createDispatcher: createProxyDispatcher }),
	})
}

/** One request owns session documents and reads only the supplied Vault bindings. */
export function snapshotRequestCoreFacilitiesConfig(
	input: CoreFacilitiesConfig = {},
): PreparedCoreFacilities {
	assertCoreConfigObject(input, '[core] Request Host facilities', requestFacilityFields)
	const vault = snapshotVaultConfig(input.vault)
	if (vault.backend === 'encrypted' || vault.deployIdentity !== undefined)
		throw new TypeError('[core.vault] Request Host supports only deployment bindings')
	return prepareFacilities(input, {
		createStorage: createMemoryStorage,
		// LogTape categories live for the isolate. Correlate requests in record properties.
		createLoggerConfig: () => ({ rootId: 'worker-request', requestId: crypto.randomUUID() }),
		vault: Object.freeze({ backend: 'bindings' }),
		http: snapshotOutboundHttpOptions(input.http),
	})
}

export function assertPreparedCoreFacilities(input: PreparedCoreFacilities): void {
	if (!snapshots.has(input)) throw new TypeError('[core] expected prepared Core facilities')
}
