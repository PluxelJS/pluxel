import type { ServiceTestHost, ServiceTestHostOptions } from '@pluxel/services/internal/test'
import type { WorkbenchTestDriver } from '@pluxel/workbench/test'

export { definePluginFork, PluginLifecycleAssertionError } from '@pluxel/core/internal/test'
export type {
	DependencyOverrideInput,
	DependencyOverrideTarget,
	ProviderDefaultInput,
	PluginInitialConfigOptions,
	LifecycleFailureCommitSummary,
	PluginForkRef,
	PluginInstanceFor,
	PluginInstances,
	PluginLifecycleAssertionOperation,
	PluginTestCommitSummary,
	PluginTestLifecycleIssue,
	PluginTestTarget,
	RawPluginConfig,
} from '@pluxel/core/internal/test'
export type {
	ServicePluginStartOptions as PluginStartOptions,
	ServicePluginBatchStartOptions as PluginBatchStartOptions,
	ServicePluginTestChange as PluginTestChange,
	ServiceConfigTestDriver as ConfigTestDriver,
	ServiceHttpTestDriver as HttpTestDriver,
	ServiceCommandsTestDriver as CommandsTestDriver,
} from '@pluxel/services/internal/test'
export type { WorkbenchTestDriver, WorkbenchTestOpenOptions } from '@pluxel/workbench/test'

export type TestHostOptions<TWorkbench extends boolean = boolean> = Omit<
	ServiceTestHostOptions,
	'services' | 'management'
> &
	Readonly<{
		/** Complete service list. Defaults to []; no implicit standardServices installation. */
		services?: ServiceTestHostOptions['services']
		/** Defaults to workbench's value. Explicit false conflicts with workbench: true. */
		management?: boolean
		/** Install the local Workbench test plane. Requires HTTP and Persistence. Defaults to false. */
		workbench?: TWorkbench
	}>

export type TestHost<TWorkbench extends boolean = false> = ServiceTestHost &
	(boolean extends TWorkbench
		? { readonly workbench?: WorkbenchTestDriver }
		: TWorkbench extends true
			? { readonly workbench: WorkbenchTestDriver }
			: {})

/**
 * Creates an isolated production Host. Services default to an empty list.
 * Owns test drivers and source compilers; await disposal even after a failed assertion.
 */
export async function createTestHost<const TWorkbench extends boolean = false>(
	options: TestHostOptions<TWorkbench> = {},
): Promise<TestHost<TWorkbench>> {
	const { createServiceInternalTestHost, attachTestNodeCompiler } =
		await import('@pluxel/services/internal/test')
	const { resolvePluginTestTarget } = await import('@pluxel/core/internal/test')
	let driver: { dispose(): Promise<void>; workbench: WorkbenchTestDriver } | undefined
	let compiler: AsyncDisposable | undefined
	const internal = await createServiceInternalTestHost(
		{ ...options, services: options.services ?? [] },
		{ beforeClose: () => driver?.dispose() },
	)
	try {
		compiler = await attachTestNodeCompiler(internal.ctx)
		if (options.workbench) {
			const { createWorkbenchTestDriver } = await import('@pluxel/workbench/internal/test')
			driver = createWorkbenchTestDriver({
				ctx: internal.ctx,
				resolveTarget(target) {
					internal.isRunning(target)
					return resolvePluginTestTarget(target).address
				},
			})
		}
	} catch (error) {
		await close([error])
		throw error
	}

	async function close(errors: unknown[] = []): Promise<void> {
		try {
			await internal.dispose()
		} catch (error) {
			errors.push(error)
		}
		try {
			await compiler?.[Symbol.asyncDispose]()
		} catch (error) {
			errors.push(error)
		}
		if (errors.length === 1) throw errors[0]
		if (errors.length > 1) throw new AggregateError(errors, '[pluxel/test] Host cleanup failed')
	}
	let disposal: Promise<void> | undefined
	const dispose = () => (disposal ??= close())
	return Object.freeze({
		config: internal.config,
		http: internal.http,
		commands: internal.commands,
		start: internal.start,
		stop: internal.stop,
		restart: internal.restart,
		replaceDefinition: internal.replaceDefinition,
		commit: internal.commit,
		commitExpectFail: internal.commitExpectFail,
		require: internal.require,
		isRunning: internal.isRunning,
		...(driver ? { workbench: driver.workbench } : {}),
		dispose,
		[Symbol.asyncDispose]: dispose,
	}) as unknown as TestHost<TWorkbench>
}
