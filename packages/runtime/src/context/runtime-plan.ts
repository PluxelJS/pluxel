import {
	createContextHost,
	type Context,
	type RootCapabilityInstallation,
	type RootContext,
} from '@pluxel/core'
import {
	CONFIG_SERVICE_CAPABILITY,
	createCoreContextInstallations,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
	resolveCoreRootInputs,
	type ContextCapabilityInstallation,
} from '@pluxel/core/internal'
import { bindContextRuntimeLogging, type RuntimeLogging } from '../logger/logging'
import {
	NodeModuleService,
	type NodeModuleArtifactHostOptions,
} from '../node-artifact/NodeModuleService'
import { WorkerTaskService } from '../node-artifact/WorkerTaskService'
import { resolveRuntimePlanePlan } from '../runtime-plane'
import { CommandsService } from '../services/CommandsService'
import { ConfigService, type ConfigServiceConfig } from '../services/ConfigService'
import {
	DatabaseService,
	type DatabaseConfig,
	type DatabaseServiceHostOptions,
} from '../services/DatabaseService'
import { RuntimeStateStore, type RuntimeStateStoreConfig } from '../services/RuntimeStateStore'
import { RuntimeManagementService } from '../services/RuntimeManagementService'
import { AdminAccessService } from '../services/admin-access/AdminAccessService'
import { ManagementAccessService } from '../services/admin-access/ManagementAccessService'
import { HttpService, type RuntimeHttpHostConfig } from '../services/http/HttpService'
import { ElysiaApplicationDirectory } from '../services/http/ElysiaApplicationDirectory'
import type { Elysia } from 'elysia'
import { RUNTIME_HTTP_CAPABILITY } from './runtime-http-capability'
import { InternalApiValidationService } from '../services/http/InternalApiValidationService'
import {
	PersistenceService,
	type PersistenceServiceConfig,
} from '../services/persistence/PersistenceService'
import { VaultAdminService, VaultService } from '../services/vault/VaultService'
import type { VaultServiceConfig } from '../services/vault/types'
import type {
	WorkbenchBackend,
	WorkbenchBackendFactory,
	WorkbenchInstallOptions,
} from '../services/workbench'
import { WorkbenchService } from '../services/workbench/WorkbenchService'
import { PluginCatalogLayoutService } from '../services/management/PluginCatalogLayoutService'
import { resolveWorkbenchUiBasePath } from '../workbench-config'
import { readProductDescriptor, type HostApplicationMeta } from '../product-contract'
import type { RuntimeHostConfig } from './runtime-contract'
import { assertRuntimeHostConfig } from './runtime-config-validation'
import { RUNTIME_STATE_CAPABILITY } from './runtime-state-capability'
import './runtime-contract'

const PERSISTENCE_CAPABILITY = defineContextCapability<PersistenceService>('runtime.persistence')
const ADMIN_ACCESS_CAPABILITY = defineContextCapability<AdminAccessService>('runtime.admin-access')
const MANAGEMENT_ACCESS_CAPABILITY = defineContextCapability<ManagementAccessService>(
	'runtime.management-access',
)
const RUNTIME_MANAGEMENT_CAPABILITY =
	defineContextCapability<RuntimeManagementService>('runtime.management')
const DATABASE_CAPABILITY = defineContextCapability<DatabaseService>('runtime.database')
const COMMANDS_CAPABILITY = defineContextCapability<CommandsService>('runtime.commands')
const ELYSIA_CAPABILITY = defineContextCapability<Elysia>('runtime.elysia')
const WORKBENCH_CAPABILITY = defineContextCapability<WorkbenchService>('runtime.workbench')
const NODE_MODULES_CAPABILITY = defineContextCapability<NodeModuleService>('runtime.node-modules')
const WORKERS_CAPABILITY = defineContextCapability<WorkerTaskService>('runtime.workers')
const INTERNAL_API_VALIDATION_CAPABILITY = defineContextCapability<InternalApiValidationService>(
	'runtime.internal-api-validation',
)
const PLUGIN_CATALOG_LAYOUT_CAPABILITY = defineContextCapability<PluginCatalogLayoutService>(
	'runtime.plugin-catalog-layout',
)
const VAULT_CAPABILITY = defineContextCapability<VaultService>('runtime.vault')
const VAULT_ADMIN_CAPABILITY = defineContextCapability<VaultAdminService>('runtime.vault-admin')
const PREPARATION_BY_ROOT = new WeakMap<RootContext, Promise<void>>()

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
	database: DatabaseServiceHostOptions
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

/** @internal Create the sole root shape used by static, dynamic and test runtime hosts. */
export function createRuntimeRootContext(
	config: RuntimeHostConfig = {},
	options: RuntimeRootContextOptions = {},
): RootContext {
	assertRuntimeHostConfig(config)
	const coreInputs = resolveCoreRootInputs(config)
	const inputs = resolveRuntimeRootInputs(config, options)
	const applications = new ElysiaApplicationDirectory()
	const installations = createRuntimeContextInstallations(inputs, applications)
	const host = createContextHost({
		name: 'runtime',
		capabilities: [
			...createCoreContextInstallations(coreInputs, applications.lifecycleHooks),
			...installations,
			...(options.routeContextCapabilities ?? []),
		],
		overrides: [
			installRootCapability(CONFIG_SERVICE_CAPABILITY, {
				create: (ctx) => new ConfigService(ctx as RootContext, inputs.configService),
			}),
		],
	})
	const root = host.createRoot(inputs.name) as RootContext
	if (options.logging) {
		const unbind = bindContextRuntimeLogging(root, options.logging)
		root.effects.defer(unbind, { tag: 'RuntimeLoggingBinding', phase: 'shutdown' })
	}
	return root
}

/** @internal Prepare the Runtime-owned startup capabilities exactly once per successful root. */
export function prepareRuntimeRootContext(root: RootContext): Promise<void> {
	const existing = PREPARATION_BY_ROOT.get(root)
	if (existing) return existing
	let task!: Promise<void>
	task = Promise.resolve()
		.then(async (): Promise<void> => {
			const workbench = root.workbench?.requireBackend()
			await Promise.all([workbench?.prepare(), root.vaultAdmin?.prepare()])
			return undefined
		})
		.catch((error: unknown) => {
			if (PREPARATION_BY_ROOT.get(root) === task) PREPARATION_BY_ROOT.delete(root)
			throw error
		})
	PREPARATION_BY_ROOT.set(root, task)
	return task
}

function createRuntimeContextInstallations(
	inputs: RuntimeRootInputs,
	applications: ElysiaApplicationDirectory,
): readonly ContextCapabilityInstallation[] {
	const installations: ContextCapabilityInstallation[] = [
		installRootCapability(PERSISTENCE_CAPABILITY, {
			property: 'persistence',
			create: (ctx) => new PersistenceService(ctx as RootContext, inputs.persistence),
		}),
		installRootCapability(RUNTIME_STATE_CAPABILITY, {
			create: (ctx) => new RuntimeStateStore(ctx as RootContext, inputs.runtimeState),
		}),
		installScopeCapability(DATABASE_CAPABILITY, {
			property: 'database',
			create: (ctx) => new DatabaseService(ctx as Context, inputs.database),
		}),
		installScopeCapability(ELYSIA_CAPABILITY, {
			property: 'elysia',
			create: (ctx) => applications.applicationFor(ctx as Context),
		}),
		installOwnerViewCapability(COMMANDS_CAPABILITY, {
			property: 'commands',
			createRoot: (root) => new CommandsService(root as RootContext, undefined),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : new CommandsService(owner as Context, undefined),
		}),
		installRootCapability(RUNTIME_HTTP_CAPABILITY, {
			create: (root) => HttpService.createRoot(root as RootContext, inputs.http, applications),
		}),
		installOwnerViewCapability(NODE_MODULES_CAPABILITY, {
			property: 'nodeModules',
			createRoot: (root) => new NodeModuleService(root as RootContext, inputs.nodeArtifacts),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : new NodeModuleService(owner as Context),
		}),
		installOwnerViewCapability(WORKERS_CAPABILITY, {
			property: 'workers',
			createRoot: (root) => new WorkerTaskService(root as RootContext, inputs.workers),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : new WorkerTaskService(owner as Context, undefined),
		}),
	]

	if (inputs.management) {
		installations.push(
			installRootCapability(ADMIN_ACCESS_CAPABILITY, {
				property: 'adminAccess',
				create: (ctx) => new AdminAccessService(ctx as RootContext),
			}),
			installOwnerViewCapability(MANAGEMENT_ACCESS_CAPABILITY, {
				property: 'managementAccess',
				createRoot: (root) =>
					new ManagementAccessService(
						root as RootContext,
						resolveContextCapability(root, ADMIN_ACCESS_CAPABILITY),
					),
				createView: (rootService, owner) =>
					owner === owner.root
						? rootService
						: new ManagementAccessService(
								owner as Context,
								resolveContextCapability(owner.root, ADMIN_ACCESS_CAPABILITY),
							),
			}),
			installRootCapability(RUNTIME_MANAGEMENT_CAPABILITY, {
				property: 'runtimeManagement',
				create: (root) => new RuntimeManagementService(root as RootContext, inputs.application),
			}),
			installOwnerViewCapability(INTERNAL_API_VALIDATION_CAPABILITY, {
				property: 'internalApiValidation',
				createRoot: (root) => new InternalApiValidationService(root as RootContext),
				createView: (rootService, owner) =>
					owner === owner.root ? rootService : rootService.forOwner(owner as Context),
			}),
			installRootCapability(PLUGIN_CATALOG_LAYOUT_CAPABILITY, {
				property: 'pluginCatalogLayout',
				create: (root) => new PluginCatalogLayoutService(root as RootContext),
			}),
		)
	}

	if (inputs.workbench) installations.push(installWorkbenchCapability(inputs.workbench))

	if (inputs.vault) {
		installations.push(
			installOwnerViewCapability(VAULT_CAPABILITY, {
				property: 'vault',
				createRoot: (root) => new VaultService(root as RootContext, inputs.vault),
				createView: (rootService, owner) =>
					owner === owner.root ? rootService : rootService.forOwner(owner as Context),
			}),
			installRootCapability(VAULT_ADMIN_CAPABILITY, {
				property: 'vaultAdmin',
				create: (root) =>
					new VaultAdminService(
						root as RootContext,
						resolveContextCapability(root, VAULT_CAPABILITY),
					),
			}),
		)
	}

	return Object.freeze(installations)
}

type WorkbenchRootCapability = Readonly<{
	backend: WorkbenchBackend
	view: WorkbenchService
}>

function installWorkbenchCapability(
	input: NonNullable<RuntimeRootInputs['workbench']>,
): ContextCapabilityInstallation<WorkbenchService> {
	return installOwnerViewCapability<WorkbenchRootCapability, WorkbenchService>(
		WORKBENCH_CAPABILITY,
		{
			property: 'workbench',
			createRoot: (root) => {
				const runtimeRoot = root as RootContext
				const backend = input.createBackend(runtimeRoot, input.options)
				return Object.freeze({ backend, view: new WorkbenchService(runtimeRoot, backend) })
			},
			createView: (rootValue, owner) =>
				owner === owner.root
					? rootValue.view
					: new WorkbenchService(owner as Context, rootValue.backend),
		},
	)
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
	const database = Object.freeze({
		database: snapshotDatabase(config.database),
		persistence,
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
