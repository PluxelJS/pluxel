import './runtime/register/full'
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
import { bootstrapHostVault } from './services/vault'

export {
	BaseFeature,
	BasePlugin,
	Config,
	defineOptionalFeature,
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
	UseFeature,
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
	return createCoreHost(
		{
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
		},
		{
			prepareCommit: async (ctx) => {
				await bootstrapHostVault(ctx)
			},
		},
	)
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
	return createCoreContext({
		persistence: { mode: 'memory' },
		configService: { mode: 'memory' },
		runtimeState: { mode: 'memory' },
		...config,
	})
}

export async function withRuntimeContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	return withCoreContext(fn, {
		persistence: { mode: 'memory' },
		configService: { mode: 'memory' },
		runtimeState: { mode: 'memory' },
		...config,
	})
}
