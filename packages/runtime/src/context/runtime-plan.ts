import { readRuntimeRouteCapabilities } from '../runtime/capabilities'
import { management as installManagement } from '@pluxel/management/service'
import { installedLogging, type RuntimeLogging } from '@pluxel/logging/internal'
import { managementAccess as installManagementAccess } from '@pluxel/management/access'
import { pglite } from '@pluxel/services/database/pglite'
import { postgres } from '@pluxel/services/database/postgres'
import { type Context, type RootContext } from '@pluxel/core'
import { installRootCapability, type RootCapabilityInstallation } from '@pluxel/core/host'
import { createPluginLogPolicyStore } from '@pluxel/logging'
import {
	nodeModules as installNodeModules,
	type NodeModuleArtifactHostOptions,
} from '@pluxel/services/node'
import { workers as installWorkers } from '@pluxel/services/workers'
import { resolveRuntimePlanePlan } from '../runtime-plane'
import { Commands, commands as installCommands } from '@pluxel/services/commands'
import { createPluginManagementCommands } from '../services/commands/plugin-management'
import type { ConfigServiceConfig } from '../services/ConfigService'
import { database as installDatabase, type DatabaseBackend } from '@pluxel/services/database'
import type { DatabaseConfig } from '../services/database-config'
import type { RuntimeStateStoreConfig } from '../services/RuntimeStateStore'
import { HttpService, type RuntimeHttpHostConfig } from '../services/http/HttpService'
import { http as installHttp } from '@pluxel/services/http'
import { RUNTIME_HTTP_CAPABILITY } from './runtime-http-capability'
import {
	PersistenceService,
	type PersistenceServiceConfig,
} from '@pluxel/services/internal/persistence'
import { persistence as installPersistence } from '@pluxel/services/persistence'
import { vault as installVault } from '@pluxel/services/vault'
import { requireHostStateStore } from '@pluxel/host/internal'
import {
	createHost,
	defineHostService,
	type PluginHost,
	type HostService,
	type HostStoreStorageOptions,
} from '@pluxel/host'
import { mergeConfigRecords, configRecordsFromEnvironment } from '../services/config-environment'
import type { VaultServiceConfig } from '@pluxel/services/internal/vault-types'
import type { WorkbenchBackendFactory, WorkbenchInstallOptions } from '@pluxel/workbench/server'
import { createWorkbenchService } from '@pluxel/workbench/internal'
import { resolveWorkbenchUiBasePath } from '../workbench-config'
import {
	readProductDescriptor,
	type HostApplicationMeta,
} from '@pluxel/management/internal/product-contract'
import type { RuntimeHostConfig } from './runtime-contract'
import { assertRuntimeHostConfig } from './runtime-config-validation'
import { RUNTIME_STATE_CAPABILITY } from './runtime-state-capability'
import './runtime-contract'

const HOSTS_BY_ROOT = new WeakMap<RootContext, PluginHost>()

export type RuntimeRootContextOptions = Readonly<{
	logging?: RuntimeLogging
	product?: WorkbenchInstallOptions['product']
	/** @internal Trusted route packages may add package-private capabilities before root creation. */
	routeContextCapabilities?: readonly RootCapabilityInstallation<unknown, undefined>[]
	workbench?: Readonly<{
		createBackend: WorkbenchBackendFactory
	}>
	/** @internal Test hosts may model a physical peer without attaching a carrier. */
	requestAddress?: RuntimeHttpHostConfig['requestAddress']
}>

type RuntimeRootInputs = Readonly<{
	name: string
	persistence?: PersistenceServiceConfig
	configService?: ConfigServiceConfig
	runtimeState?: RuntimeStateStoreConfig
	database: DatabaseBackend | false
	workers?: RuntimeHostConfig['workers']
	http: RuntimeHttpHostConfig
	nodeArtifacts: NodeModuleArtifactHostOptions
	vault?: VaultServiceConfig
	application: HostApplicationMeta
	management: boolean
	workbench?: Readonly<{
		createBackend: WorkbenchBackendFactory
		options: WorkbenchInstallOptions
	}>
}>

/** @internal Compose the default product through the same prepared Host as standalone applications. */
export async function createRuntimeRootContext(
	config: RuntimeHostConfig = {},
	options: RuntimeRootContextOptions = {},
): Promise<RootContext> {
	assertRuntimeHostConfig(config)
	const inputs = resolveRuntimeRootInputs(config, options)
	const persistence = new PersistenceService(inputs.persistence ?? { mode: 'memory' })
	let managementRoot: RootContext | undefined
	const services: HostService[] = [
		...(options.logging
			? [
					installedLogging(options.logging, {
						policyStore: createPluginLogPolicyStore(persistence.namespace('logger')),
					}),
				]
			: []),
		...(inputs.management
			? [
					installManagementAccess(),
					installManagement({
						application: inputs.application,
						workbench: !!inputs.workbench,
						recentUpdate: {
							latestUpdate: () =>
								managementRoot
									? (readRuntimeRouteCapabilities(managementRoot)?.recentUpdate?.latestUpdate?.() ??
										null)
									: null,
							resolveRecentUpdate: (address) =>
								managementRoot
									? (readRuntimeRouteCapabilities(
											managementRoot,
										)?.recentUpdate?.resolveRecentUpdate(address) ?? null)
									: null,
							subscribeUpdates: (observer) =>
								managementRoot
									? (readRuntimeRouteCapabilities(managementRoot)?.recentUpdate?.subscribeUpdates?.(
											observer,
										) ?? (() => {}))
									: () => {},
						},
					}),
				]
			: []),
		installHttp(),
		...(inputs.database ? [installDatabase({ backend: inputs.database })] : []),
		installCommands(),
		installNodeModules(inputs.nodeArtifacts),
		installWorkers(inputs.workers),
		installPersistence({ mode: 'custom', backend: persistence }),
		...(inputs.vault ? [installVault(inputs.vault)] : []),
		...(inputs.workbench
			? [createWorkbenchService(inputs.workbench.options, inputs.workbench.createBackend)]
			: []),
	]
	const runtime = defineHostService({
		name: 'Runtime product',
		capabilities: [
			installRootCapability(RUNTIME_STATE_CAPABILITY, {
				create: (ctx) => requireHostStateStore(ctx),
			}),
			installRootCapability(RUNTIME_HTTP_CAPABILITY, {
				create: (root) => HttpService.createRoot(root, inputs.http),
			}),
			...(options.routeContextCapabilities ?? []),
		],
		prepare({ ctx }) {
			managementRoot = ctx
			const catalog = ctx.require(Commands)
			for (const command of createPluginManagementCommands(ctx)) catalog.register(command)
		},
	})
	const host = await createHost({
		plugins: [],
		config: {
			name: inputs.name,
			logger: config.logger,
			events: config.events,
			plugins: config.plugins,
		},
		services: [...services, runtime],
		configRecords: {
			...storeStorage(persistence, 'config', inputs.configService?.mode),
			initial: mergeConfigRecords(
				inputs.configService?.snapshot?.plugins,
				configRecordsFromEnvironment(inputs.configService?.environment),
			),
		},
		state: {
			...storeStorage(persistence, 'runtime-state', inputs.runtimeState?.mode),
			initial: inputs.runtimeState?.snapshot,
		},
	})
	HOSTS_BY_ROOT.set(host.ctx, host)
	host.ctx.effects.defer(
		() => {
			HOSTS_BY_ROOT.delete(host.ctx)
		},
		{ tag: 'RuntimeHostBinding' },
	)
	return host.ctx
}

export function requireRuntimePluginHost(ctx: Context): PluginHost {
	const host = HOSTS_BY_ROOT.get(ctx.root)
	if (!host) throw new Error('[runtime] Context has no Runtime product Host')
	return host
}

function resolveRuntimeRootInputs(
	config: RuntimeHostConfig,
	options: RuntimeRootContextOptions,
): RuntimeRootInputs {
	const planes = resolveRuntimePlanePlan(config.workbench, config.management)
	if (planes.workbench && !options.workbench) {
		throw new Error(
			'[pluxel/runtime] Workbench is enabled but this host did not provide a Workbench backend factory.',
		)
	}

	const persistence = snapshotPersistence(config.persistence)
	const nodeArtifacts = Object.freeze({
		...(normalizePath(config.nodeModuleArtifactRoot)
			? { root: normalizePath(config.nodeModuleArtifactRoot) }
			: {}),
		...(config.nodeModuleArtifactResolver ? { resolve: config.nodeModuleArtifactResolver } : {}),
	})
	const workbenchArtifactRoot = normalizePath(config.workbenchArtifactRoot)
	const workbenchArtifacts = Object.freeze(
		workbenchArtifactRoot ? { root: workbenchArtifactRoot } : {},
	)
	const httpConfig = config.http ?? {}
	const http: RuntimeHttpHostConfig = Object.freeze({
		management: planes.management,
		workbench: planes.workbench,
		uiBasePath: resolveWorkbenchUiBasePath(config.workbench),
		...(httpConfig.uiAssets ? { uiAssets: httpConfig.uiAssets } : {}),
		...(httpConfig.uiPublicDir ? { uiPublicDir: httpConfig.uiPublicDir } : {}),
		...(options.requestAddress ? { requestAddress: options.requestAddress } : {}),
	})
	const configuredDatabase = snapshotDatabase(config.database)
	const database: DatabaseBackend | false =
		configuredDatabase === false
			? false
			: configuredDatabase?.driver === 'postgres'
				? postgres(configuredDatabase)
				: pglite({
						dataDir:
							configuredDatabase?.dataDir ??
							(typeof persistence === 'string'
								? `${persistence}/database/pglite`
								: persistence?.mode === 'memory'
									? 'memory://'
									: '.pluxel/persistence/database/pglite'),
					})
	const vault = snapshotVault(config.vault)
	const application = Object.freeze({
		product:
			options.product === undefined || options.product === null
				? null
				: readProductDescriptor(options.product, '[pluxel/runtime] product'),
	})

	return Object.freeze({
		name: config.name ?? 'root',
		persistence,
		configService: snapshotConfigService(config.configService),
		runtimeState: snapshotRuntimeState(config.runtimeState),
		database,
		workers: config.workers ? Object.freeze({ ...config.workers }) : undefined,
		http,
		nodeArtifacts,
		vault,
		application,
		management: planes.management,
		...(planes.workbench && options.workbench
			? {
					workbench: Object.freeze({
						createBackend: options.workbench.createBackend,
						options: Object.freeze({
							product: application.product,
							artifacts: workbenchArtifacts,
						}),
					}),
				}
			: {}),
	})
}

function snapshotPersistence(
	config: PersistenceServiceConfig | undefined,
): PersistenceServiceConfig | undefined {
	return typeof config === 'string' || config === undefined ? config : Object.freeze({ ...config })
}

function snapshotDatabase(config: DatabaseConfig | undefined): DatabaseConfig | undefined {
	if (config === undefined || config === false) return config
	return Object.freeze({
		...config,
		...(config.driver === 'postgres' && config.pool
			? { pool: Object.freeze({ ...config.pool }) }
			: {}),
	}) as DatabaseConfig
}

function snapshotVault(value: RuntimeHostConfig['vault']): VaultServiceConfig | undefined {
	if (value === undefined || value === false) return undefined
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[pluxel/runtime] vault must be false or a Vault configuration object')
	}
	return Object.freeze({ ...value })
}

function snapshotConfigService(
	config: ConfigServiceConfig | undefined,
): ConfigServiceConfig | undefined {
	if (!config) return undefined
	return Object.freeze({
		...config,
		...(config.environment ? { environment: Object.freeze({ ...config.environment }) } : {}),
		...(config.snapshot ? { snapshot: clonePlainData(config.snapshot) } : {}),
	})
}

function snapshotRuntimeState(
	config: RuntimeStateStoreConfig | undefined,
): RuntimeStateStoreConfig | undefined {
	if (!config) return undefined
	const snapshot = config.snapshot
	return Object.freeze({
		...config,
		...(snapshot
			? {
					snapshot: Object.freeze({
						...clonePlainData(snapshot),
						...(snapshot.autoStart
							? {
									autoStart: Object.freeze(
										[...snapshot.autoStart].map((item) => clonePlainData(item)),
									),
								}
							: {}),
					}),
				}
			: {}),
	})
}

function clonePlainData<T>(value: T): T {
	if (Array.isArray(value)) return Object.freeze(value.map((item) => clonePlainData(item))) as T
	if (!value || typeof value !== 'object') return value
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return value
	return Object.freeze(
		Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlainData(item)])),
	) as T
}

function normalizePath(value: string | undefined): string | undefined {
	const normalized = value?.trim()
	return normalized || undefined
}

function storeStorage(
	persistence: PersistenceService,
	namespace: string,
	mode?: 'file' | 'memory' | 'readonly',
): HostStoreStorageOptions {
	if (mode === 'memory') return { mode: 'memory' }
	return {
		storage: persistence.namespace(namespace),
		mode:
			mode === 'readonly' || (mode === undefined && persistence.capability === 'readonly')
				? 'readonly'
				: 'writable',
	}
}
