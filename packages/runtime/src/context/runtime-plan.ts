import type { RootContext } from '@pluxel/core'
import {
	CONFIG_SERVICE_CAPABILITY,
	createContextPlan,
	createCoreContextInstallations,
	createRootContext,
	defineContextCapability,
	installGenerationCapability,
	installOwnerViewCapability,
	installRootCapability,
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
import { resolveRuntimePlanePlan, type PluginGroupConfig } from '../management-config'
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
import { AgentToolsService } from '../services/commands/AgentToolsService'
import { HttpService, type RuntimeHttpHostConfig } from '../services/http/HttpService'
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
import {
	PluginCatalogLayoutService,
	validatePluginGroups,
} from '../services/management/PluginCatalogLayoutService'
import { resolveWorkbenchUiBasePath } from '../workbench-config'
import { readProductDescriptor, type HostApplicationMeta } from '../product-contract'
import type { RuntimeHostConfig } from './runtime-contract'
import { RUNTIME_STATE_CAPABILITY } from './runtime-state-capability'
import './runtime-contract'

const PERSISTENCE_CAPABILITY = defineContextCapability<PersistenceService>('runtime.persistence')
const ADMIN_ACCESS_CAPABILITY = defineContextCapability<AdminAccessService>('runtime.admin-access')
const RUNTIME_MANAGEMENT_CAPABILITY =
	defineContextCapability<RuntimeManagementService>('runtime.management')
const AGENT_TOOLS_CAPABILITY = defineContextCapability<AgentToolsService>('runtime.agent-tools')
const DATABASE_CAPABILITY = defineContextCapability<DatabaseService>('runtime.database')
const COMMANDS_CAPABILITY = defineContextCapability<CommandsService>('runtime.commands')
const HTTP_CAPABILITY = defineContextCapability<HttpService>('runtime.http')
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

export type RuntimeRootContextOptions = Readonly<{
	logging?: RuntimeLogging
	product?: WorkbenchInstallOptions['product']
	/** @internal Route packages may add package-owned capabilities before the root is created. */
	installations?: readonly ContextCapabilityInstallation[]
	workbench?: Readonly<{
		createBackend: WorkbenchBackendFactory
	}>
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
	managementAccess?: NonNullable<ReturnType<typeof resolveRuntimePlanePlan>['access']>
	pluginGroups: readonly PluginGroupConfig[]
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
	const coreInputs = resolveCoreRootInputs(config)
	const inputs = resolveRuntimeRootInputs(config, options)
	const installations = createRuntimeContextInstallations(inputs)
	const plan = createContextPlan('runtime', [
		...createCoreContextInstallations(coreInputs).filter(
			(installation) => installation.capability !== CONFIG_SERVICE_CAPABILITY,
		),
		...installations,
		...(options.installations ?? []),
	])
	const root = createRootContext(plan, inputs.name)
	if (options.logging) {
		const unbind = bindContextRuntimeLogging(root, options.logging)
		root.effects.defer(unbind, { tag: 'RuntimeLoggingBinding', phase: 'shutdown' })
	}
	return root
}

function createRuntimeContextInstallations(
	inputs: RuntimeRootInputs,
): readonly ContextCapabilityInstallation[] {
	const installations: ContextCapabilityInstallation[] = [
		installRootCapability(PERSISTENCE_CAPABILITY, {
			property: 'persistence',
			create: (ctx) => new PersistenceService(ctx, inputs.persistence),
		}),
		installRootCapability(CONFIG_SERVICE_CAPABILITY, {
			create: (ctx) => new ConfigService(ctx, inputs.configService),
		}),
		installRootCapability(RUNTIME_STATE_CAPABILITY, {
			create: (ctx) => new RuntimeStateStore(ctx, inputs.runtimeState),
		}),
		installRootCapability(AGENT_TOOLS_CAPABILITY, {
			property: 'agentTools',
			create: (ctx) => new AgentToolsService(ctx),
		}),
		installGenerationCapability(DATABASE_CAPABILITY, {
			property: 'database',
			create: (ctx) => new DatabaseService(ctx, inputs.database),
		}),
		installOwnerViewCapability(COMMANDS_CAPABILITY, {
			property: 'commands',
			createRoot: (root) => new CommandsService(root, undefined),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : new CommandsService(owner, undefined),
		}),
		installOwnerViewCapability(HTTP_CAPABILITY, {
			property: 'http',
			createRoot: (root) => new HttpService(root, inputs.http),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : rootService.forOwner(owner),
		}),
		installOwnerViewCapability(NODE_MODULES_CAPABILITY, {
			property: 'nodeModules',
			createRoot: (root) => new NodeModuleService(root, inputs.nodeArtifacts),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : new NodeModuleService(owner),
		}),
		installOwnerViewCapability(WORKERS_CAPABILITY, {
			property: 'workers',
			createRoot: (root) => new WorkerTaskService(root, inputs.workers),
			createView: (rootService, owner) =>
				owner === owner.root ? rootService : new WorkerTaskService(owner, undefined),
		}),
	]

	if (inputs.managementAccess) {
		installations.push(
			installRootCapability(ADMIN_ACCESS_CAPABILITY, {
				property: 'adminAccess',
				create: (ctx) => new AdminAccessService(ctx, inputs.managementAccess!),
			}),
			installRootCapability(RUNTIME_MANAGEMENT_CAPABILITY, {
				property: 'runtimeManagement',
				create: (root) => new RuntimeManagementService(root, inputs.application),
			}),
			installOwnerViewCapability(INTERNAL_API_VALIDATION_CAPABILITY, {
				property: 'internalApiValidation',
				createRoot: (root) => new InternalApiValidationService(root),
				createView: (rootService, owner) =>
					owner === owner.root ? rootService : rootService.forOwner(owner),
			}),
			installRootCapability(PLUGIN_CATALOG_LAYOUT_CAPABILITY, {
				property: 'pluginCatalogLayout',
				create: (root) => new PluginCatalogLayoutService(root, inputs.pluginGroups),
			}),
		)
	}

	if (inputs.workbench) installations.push(installWorkbenchCapability(inputs.workbench))

	if (inputs.vault) {
		installations.push(
			installOwnerViewCapability(VAULT_CAPABILITY, {
				property: 'vault',
				createRoot: (root) => new VaultService(root, inputs.vault),
				createView: (rootService, owner) =>
					owner === owner.root ? rootService : rootService.forOwner(owner),
			}),
			installRootCapability(VAULT_ADMIN_CAPABILITY, {
				property: 'vaultAdmin',
				create: (root) =>
					new VaultAdminService(root, resolveContextCapability(root, VAULT_CAPABILITY)),
				prepare: async (service): Promise<void> => {
					await service.prepare()
				},
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
			eager: true,
			createRoot: (root) => {
				const backend = input.createBackend(root, input.options)
				return Object.freeze({ backend, view: new WorkbenchService(root, backend) })
			},
			createView: (rootValue, owner) =>
				owner === owner.root ? rootValue.view : new WorkbenchService(owner, rootValue.backend),
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
	const pluginGroups = Object.freeze(
		(config.management?.pluginGroups ?? []).map((group) =>
			Object.freeze({
				...group,
				...(group.definitions
					? { definitions: Object.freeze(group.definitions.map((item) => clonePlainData(item))) }
					: {}),
				...(group.packages ? { packages: Object.freeze([...group.packages]) } : {}),
			}),
		),
	)
	validatePluginGroups(pluginGroups)
	const nodeArtifacts = Object.freeze({
		...(normalizePath(config.nodeModuleArtifactRoot)
			? { root: normalizePath(config.nodeModuleArtifactRoot) }
			: {}),
		...(config.nodeModuleArtifactResolver ? { resolve: config.nodeModuleArtifactResolver } : {}),
	})
	const workbenchArtifacts = Object.freeze({
		...(normalizePath(config.workbenchArtifactRoot)
			? { root: normalizePath(config.workbenchArtifactRoot) }
			: {}),
		...(config.workbenchArtifactResolver ? { resolve: config.workbenchArtifactResolver } : {}),
	})
	const httpConfig = config.http ?? {}
	const http: RuntimeHttpHostConfig = Object.freeze({
		management: planes.management,
		workbench: planes.workbench,
		uiBasePath: resolveWorkbenchUiBasePath(config.workbench),
		...(httpConfig.uiAssets ? { uiAssets: httpConfig.uiAssets } : {}),
		...(httpConfig.uiPublicDir ? { uiPublicDir: httpConfig.uiPublicDir } : {}),
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
		managementAccess: planes.access,
		pluginGroups,
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
						...(snapshot.enabled
							? {
									enabled: Object.freeze([...snapshot.enabled].map((item) => clonePlainData(item))),
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
