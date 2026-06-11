import type { Context } from '@pluxel/core'

import {
	bootPlannedLoaderHmrHost,
	planLoaderHmrHost,
	planLoaderHmrHostFromConfig,
	type BootedLoaderHmrHost,
	type LoaderHmrHostConfigInput,
	type LoaderHmrHostOptions,
} from './hmr/host'
import {
	installLoaderHmrRuntime,
	type InstallLoaderHmrRuntimeOptions,
} from './hmr/install-hmr-runtime'
import type { LoaderHmrService as InternalLoaderHmrService } from './hmr/engine/LoaderHmrService'
import type { LoaderHmrWorkspaceSnapshot } from './hmr/snapshot'

export {
	DEFAULT_LOADER_HMR_CONFIG_BASENAME,
	backupAndRewriteLoaderHmrConfigV1,
	createDefaultLoaderHmrConfigV1,
	defaultLoaderHmrConfigHeaderComment,
	diagnoseWorkspace as diagnoseLoaderHmrWorkspace,
	ensureLoaderHmrConfigV1,
	nodeLoaderHmrWorkspaceFs,
	nodeWorkspaceFs,
	parseLoaderHmrConfigV1Jsonc,
	readLoaderHmrConfigV1,
	resolveDefaultLoaderHmrConfigPath,
	validateLoaderHmrConfigV1Strict,
	writeLoaderHmrConfigV1,
} from './hmr/diagnose'
export type {
	DiscoverWorkspacePluginsInput,
	DiscoveredPlugin,
	DiagnoseWorkspaceInput as DiagnoseLoaderHmrWorkspaceInput,
	DiagnoseWorkspaceResult as DiagnoseLoaderHmrWorkspaceResult,
	LoaderHmrWorkspaceFs,
	PluxelLoaderHmrConfig,
	PluxelLoaderHmrConfigV1,
	WorkspacePackage,
	WorkspaceFs,
	WorkspaceSnapshot as LoaderHmrWorkspace,
} from './hmr/diagnose'
export {
	buildWorkspaceSnapshotFromScan as buildLoaderHmrWorkspaceFromScan,
	discoverPluginsFromPackages,
	discoverWorkspacePlugins,
	getLoaderHmrProfileBuiltinPackages,
	getLoaderHmrProfileEnabledPackages,
	mergeLoaderHmrProfile,
	readLoaderHmrConfigRaw,
	readLoaderHmrProfileView,
	resolveLoaderHmrConfigPath,
	resolveLoaderHmrConfigPathFromCwd,
	resolveLoaderHmrRootsExpanded,
	resolveLoaderHmrWorkspace,
	scanWorkspacePackages,
} from './hmr/diagnose'
export type {
	BuiltinsFromDistEntry,
	LoaderHmrWorkspaceSnapshot,
} from './hmr/snapshot'
export { assertLoaderHmrWorkspace } from './hmr/snapshot'
export type { LoaderHmrDependencyConfig } from './hmr/engine/config'
export type { LoaderHmrService } from './hmr/engine/LoaderHmrService'

export type LoaderHmrConfig = LoaderHmrHostConfigInput
export type LoaderHmrOptions = InstallLoaderHmrRuntimeOptions
export type LoaderHmrInstall = {
	ctx: Context
	hmr: InternalLoaderHmrService
	workspace: LoaderHmrWorkspaceSnapshot
}
export type LoaderHmrHost = {
	root: string
	logsDir: string
	ctx: Context
	loader: Context['loader']
	hmr: InternalLoaderHmrService
	workspace: LoaderHmrWorkspaceSnapshot
	warnings: readonly string[]
	start(): Promise<void>
	stop(): Promise<void>
}

export function defineLoaderHmrConfig(options: LoaderHmrHostConfigInput): LoaderHmrConfig {
	return options
}

export async function createLoaderHmrHost(options: {
	config: LoaderHmrConfig
}): Promise<LoaderHmrHost> {
	const plan = await planLoaderHmrHostFromConfig(options.config)
	const booted = await bootPlannedLoaderHmrHost(plan)
	return toLoaderHmrHost(booted, plan.snapshot, plan.warnings)
}

export async function createLoaderHmrHostFromSnapshot<TSnapshot extends LoaderHmrHostOptions['snapshot']>(
	options: LoaderHmrHostOptions<TSnapshot>,
): Promise<LoaderHmrHost> {
	const plan = planLoaderHmrHost(options)
	const booted = await bootPlannedLoaderHmrHost(plan)
	return toLoaderHmrHost(booted, plan.snapshot, plan.warnings)
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

function toLoaderHmrHost(
	booted: BootedLoaderHmrHost,
	workspace: LoaderHmrWorkspaceSnapshot,
	warnings: readonly string[],
): LoaderHmrHost {
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
