import './runtime/register/full'
import './services/vault'
import { installManagement } from './services/management'
import { withManagementPluginContext } from './services/management/ManagementService'
import { isManagementEnabled, managementAdminAccess } from './management-config'
import {
	createCoreContext,
	createCoreHost,
	type Context,
	type CoreHost,
	type CoreHostConfigHandle,
	type CoreHostConfigPatch,
	type CoreHostConfigPatchByName,
	type CoreHostConfigPatchFor,
	type CoreTestContext,
	type PluginConstructor,
} from '@pluxel/core/test'

export {
	BaseFeature,
	BasePlugin,
	Config,
	defineLazyFeature,
	FeatureHost,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	assertPluginLifecycleIssue,
	checkPluginDecorator,
	clearParamToken,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	collectPluginLifecycleStoppedWithErrors,
	Context,
	findPluginLifecycleIssue,
	getPluginInfo,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleNotStartedIssue,
	isPluginLifecycleStoppedWithErrorIssue,
	pluginLifecycleIssuePlugins,
	setParamToken,
	setParamTokens,
} from '@pluxel/core/test'
export type {
	CommitSummary,
	CoreHostLifecycleIssueExpectation,
	PluginLifecycleErrorInfo,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginLifecycleReport,
	PluginCommitChanges,
	PluginReplacement,
	RuntimeUpdateCommitSummary,
} from '@pluxel/core/test'

export type RuntimeHost = CoreHost
export type RuntimeTestContext = CoreTestContext
export type RuntimeHostConfigPatch<T extends PluginConstructor> = CoreHostConfigPatch<T>
export type RuntimeHostConfigPatchByName = CoreHostConfigPatchByName
export type RuntimeHostConfigPatchFor<TTarget extends string | PluginConstructor> =
	CoreHostConfigPatchFor<TTarget>
export type RuntimeHostConfigHandle<TTarget extends string | PluginConstructor> =
	CoreHostConfigHandle<TTarget>

export function createRuntimeHost(config: Context.Config = {}): RuntimeHost {
	const management = config.management ?? {
		enabled: true,
		access: { exposure: 'private' as const },
	}
	const host = createCoreHost(
		withManagementPluginContext({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
			management,
			adminAccess: config.adminAccess ?? managementAdminAccess(management),
		}),
		{
			prepareCommit: async (ctx) => {
				await ctx.prepareServices()
			},
		},
	)
	if (isManagementEnabled(management)) installManagement(host.ctx)
	return host
}

export async function withRuntimeHost<T>(
	fn: (host: RuntimeHost) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const host = createRuntimeHost(config)
	try {
		return await fn(host)
	} finally {
		await host.dispose()
	}
}

export function createRuntimeContext(config: Context.Config = {}): RuntimeTestContext {
	const management = config.management ?? {
		enabled: true,
		access: { exposure: 'private' as const },
	}
	const ctx = createCoreContext(
		withManagementPluginContext({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
			management,
			adminAccess: config.adminAccess ?? managementAdminAccess(management),
		}),
	)
	if (isManagementEnabled(management)) installManagement(ctx.ctx)
	return ctx
}

export async function withRuntimeContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const runtime = createRuntimeContext({
		persistence: { mode: 'memory' },
		configService: { mode: 'memory' },
		runtimeState: { mode: 'memory' },
		...config,
	})
	try {
		return await fn(runtime.ctx)
	} finally {
		await runtime.dispose()
	}
}
