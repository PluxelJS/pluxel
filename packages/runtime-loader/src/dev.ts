import type { Context } from '@pluxel/core'

import {
	bootPlannedLoaderDevHost,
	planLoaderDevHost,
	planLoaderDevHostFromConfig,
	type BootedLoaderDevHost,
	type LoaderDevHostConfigInput,
	type LoaderDevHostOptions,
} from './dev/host'
import {
	installLoaderHmrRuntime,
	type InstallLoaderHmrRuntimeOptions,
	type InstallLoaderHmrRuntimeResult,
} from './dev/install-hmr-runtime'
import type { LoaderHmrService as InternalLoaderHmrService } from './dev/hmr/LoaderHmrService'

export {
	DEFAULT_LOADER_DEV_CONFIG_BASENAME,
	backupAndRewriteLoaderDevConfigV1,
	createDefaultLoaderDevConfigV1,
	defaultLoaderDevConfigHeaderComment,
	diagnoseWorkspace as diagnoseLoaderDevWorkspace,
	ensureLoaderDevConfigV1,
	nodeLoaderDevWorkspaceFs,
	nodeWorkspaceFs,
	parseLoaderDevConfigV1Jsonc,
	readLoaderDevConfigV1,
	resolveDefaultLoaderDevConfigPath,
	validateLoaderDevConfigV1Strict,
	writeLoaderDevConfigV1,
} from './dev/diagnose'
export type {
	DiscoverWorkspacePluginsInput,
	DiscoveredPlugin,
	DiagnoseWorkspaceInput as DiagnoseLoaderDevWorkspaceInput,
	DiagnoseWorkspaceResult as DiagnoseLoaderDevWorkspaceResult,
	LoaderDevWorkspaceFs,
	PluxelLoaderDevConfig,
	PluxelLoaderDevConfigV1,
	WorkspacePackage,
	WorkspaceFs,
	WorkspaceSnapshot as LoaderDevWorkspace,
} from './dev/diagnose'
export {
	buildWorkspaceSnapshotFromScan as buildLoaderDevWorkspaceFromScan,
	discoverPluginsFromPackages,
	discoverWorkspacePlugins,
	getLoaderDevProfileBuiltinPackages,
	getLoaderDevProfileEnabledPackages,
	mergeLoaderDevProfile,
	readLoaderDevConfigRaw,
	readLoaderDevProfileView,
	resolveLoaderDevConfigPath,
	resolveLoaderDevConfigPathFromCwd,
	resolveLoaderDevRootsExpanded,
	resolveLoaderDevWorkspace,
	scanWorkspacePackages,
} from './dev/diagnose'
export type {
	BuiltinsFromDistEntry,
	LoaderDevWorkspaceSnapshot,
} from './dev/snapshot'
export { assertLoaderDevWorkspace } from './dev/snapshot'
export type { LoaderHmrDependencyConfig } from './dev/hmr/config'
export type { LoaderHmrService } from './dev/hmr/LoaderHmrService'

export type LoaderDevConfig = LoaderDevHostConfigInput
export type LoaderHmrOptions = InstallLoaderHmrRuntimeOptions
export type LoaderHmrInstall = Omit<InstallLoaderHmrRuntimeResult, 'snapshot'> & {
	hmr: InternalLoaderHmrService
	workspace: InstallLoaderHmrRuntimeResult['snapshot']
}
export type LoaderDevHost = Omit<BootedLoaderDevHost, 'hmr'> & {
	loader: Context['loader']
	hmr: InternalLoaderHmrService
	workspace: LoaderDevHostOptions['snapshot']
	warnings: readonly string[]
	start(): Promise<void>
	stop(): Promise<void>
}

export function defineLoaderDevConfig(options: LoaderDevHostConfigInput): LoaderDevConfig {
	return options
}

export async function createLoaderDevHost(options: {
	config: LoaderDevConfig
}): Promise<LoaderDevHost> {
	const plan = await planLoaderDevHostFromConfig(options.config)
	const booted = await bootPlannedLoaderDevHost(plan)
	return toLoaderDevHost(booted, plan.snapshot, plan.warnings)
}

export async function createLoaderDevHostFromWorkspace<TSnapshot extends LoaderDevHostOptions['snapshot']>(
	options: LoaderDevHostOptions<TSnapshot>,
): Promise<LoaderDevHost> {
	const plan = planLoaderDevHost(options)
	const booted = await bootPlannedLoaderDevHost(plan)
	return toLoaderDevHost(booted, plan.snapshot, plan.warnings)
}

export async function installLoaderHmr(
	ctx: Context,
	options: LoaderHmrOptions,
): Promise<LoaderHmrInstall> {
	const res = await installLoaderHmrRuntime(ctx, options)
	return {
		ctx: res.ctx,
		hmr: res.hmr,
		workspace: res.snapshot,
	}
}

function toLoaderDevHost(
	booted: BootedLoaderDevHost,
	workspace: LoaderDevHostOptions['snapshot'],
	warnings: readonly string[],
): LoaderDevHost {
	return {
		root: booted.root,
		logsDir: booted.logsDir,
		ctx: booted.ctx,
		loader: booted.ctx.loader,
		hmr: booted.hmr,
		workspace,
		warnings,
		start: () => booted.hmr.start(),
		stop: async () => {
			await booted.ctx.effects.dispose()
		},
	}
}
