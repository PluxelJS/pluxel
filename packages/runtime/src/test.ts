import './runtime/register/full'
import './services/vault'
import { installWebManagement } from './services/web-management'
import { withWebManagementPluginContext } from './services/web-management/WebManagementService'
import { isWebManagementEnabled, webManagementAdminAccess } from './web-management-config'
import {
	createCoreContext,
	createCoreHost,
	withCoreContext,
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
	const webManagement = config.webManagement ?? {
		enabled: true,
		access: { exposure: 'private' as const },
	}
	const host = createCoreHost(
		withWebManagementPluginContext({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
			webManagement,
			adminAccess: config.adminAccess ?? webManagementAdminAccess(webManagement),
		}),
		{
			prepareCommit: async (ctx) => {
				await ctx.prepareServices()
			},
		},
	)
	if (isWebManagementEnabled(webManagement)) installWebManagement(host.ctx)
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
	const webManagement = config.webManagement ?? {
		enabled: true,
		access: { exposure: 'private' as const },
	}
	const ctx = createCoreContext(
		withWebManagementPluginContext({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
			webManagement,
			adminAccess: config.adminAccess ?? webManagementAdminAccess(webManagement),
		}),
	)
	if (isWebManagementEnabled(webManagement)) installWebManagement(ctx.ctx)
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
