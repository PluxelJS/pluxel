import './index'
import './services/vault'
import { installWorkbench } from './services/workbench'
import { withWorkbenchPluginContext } from './services/workbench/WorkbenchService'
import { isWorkbenchEnabled, workbenchAdminAccess } from './workbench-config'
import {
	createCoreContext,
	createCoreHost,
	type Context,
	type CoreHost,
	type CoreHostConfigHandle,
	type CoreHostConfigPatch,
	type CoreTestContext,
	type PluginConstructor,
} from '@pluxel/core/test'

export {
	BasePlugin,
	ForkablePlugin,
	Plugin,
	assertPluginLifecycleIssue,
	checkPluginDecorator,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleDrainErrors,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	Context,
	findPluginLifecycleIssue,
	getPluginInfo,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleDrainErrorIssue,
	isPluginLifecycleNotStartedIssue,
	pluginNodeAddressOf,
	pluginLifecycleIssuePlugins,
} from '@pluxel/core/test'
export type {
	CommitSummary,
	CoreHostLifecycleIssueExpectation,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginCommitChanges,
	PluginReplacement,
	RuntimeUpdateCommitSummary,
} from '@pluxel/core/test'

export type RuntimeHost = CoreHost
export type RuntimeTestContext = CoreTestContext
export type RuntimeHostConfigPatch<T extends PluginConstructor> = CoreHostConfigPatch<T>
export type RuntimeHostConfigHandle<TTarget extends PluginConstructor> =
	CoreHostConfigHandle<TTarget>

export function createRuntimeHost(config: Context.Config = {}): RuntimeHost {
	const workbench = config.workbench ?? {
		enabled: true,
		access: { exposure: 'private' as const },
	}
	const host = createCoreHost(
		withWorkbenchPluginContext({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
			workbench,
			adminAccess: config.adminAccess ?? workbenchAdminAccess(workbench),
		}),
		{
			prepareCommit: async (ctx) => {
				await ctx.prepareServices()
			},
		},
	)
	if (isWorkbenchEnabled(workbench)) installWorkbench(host.ctx)
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
	const workbench = config.workbench ?? {
		enabled: true,
		access: { exposure: 'private' as const },
	}
	const ctx = createCoreContext(
		withWorkbenchPluginContext({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
			workbench,
			adminAccess: config.adminAccess ?? workbenchAdminAccess(workbench),
		}),
	)
	if (isWorkbenchEnabled(workbench)) installWorkbench(ctx.ctx)
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
