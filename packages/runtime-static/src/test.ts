import type { PluginConstructor, RootContext } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { assertPluginTestTargetCurrent, resolvePluginTestTarget } from '@pluxel/core/internal/test'
import type { PluginForkRef, PluginInstanceFor, PluginTestTarget } from '@pluxel/core/test'
import { createRuntimeTestDriverScope } from '@pluxel/runtime/internal/test'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import type {
	RuntimeCommandsTestDriver,
	RuntimeConfigTestDriver,
	RuntimeHttpTestDriver,
	RuntimeWorkbenchTestDriver,
} from '@pluxel/runtime/test'
import { startStaticRuntimeApplication } from './internal/application.ts'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeEnvironment,
	StaticRuntimeStartupReport,
} from './types.ts'

/** A constructor in the fixed application catalog, or a fork reference for that definition. */
export type StaticPluginTestTarget<TPlugins extends readonly PluginConstructor[]> =
	| TPlugins[number]
	| PluginForkRef<TPlugins[number]>

/** `bindings` is required exactly when the application's binding object has required fields. */
export type StaticApplicationTestHostOptions<TBindings extends StaticRuntimeBindings> = Readonly<
	{
		/** Startup environment snapshot. Omission means an empty object, never `process.env`. */
		env?: StaticRuntimeEnvironment
	} & ({} extends TBindings ? { bindings?: TBindings } : { bindings: TBindings })
>

/**
 * Ready, in-process view of one fully booted static application.
 *
 * The host owns its Runtime drivers and application lifetime. It intentionally has no lifecycle
 * mutation methods, root Context, HMR authority, or physical listener.
 */
export interface StaticApplicationTestHost<
	TPlugins extends readonly PluginConstructor[] = readonly PluginConstructor[],
> extends AsyncDisposable {
	readonly startupReport: StaticRuntimeStartupReport
	readonly config: RuntimeConfigTestDriver<StaticPluginTestTarget<TPlugins>>
	readonly http: RuntimeHttpTestDriver
	readonly commands: RuntimeCommandsTestDriver
	readonly workbench: RuntimeWorkbenchTestDriver<StaticPluginTestTarget<TPlugins>>
	/** Return the current running raw Plugin instance without creating or starting a node. */
	require<TTarget extends StaticPluginTestTarget<TPlugins>>(
		target: TTarget,
	): PluginInstanceFor<TTarget>
	/** Query the settled lifecycle state without mutating application intent. */
	isRunning(target: StaticPluginTestTarget<TPlugins>): boolean
	/** Idempotently closes child drivers before the complete static application. */
	dispose(): Promise<void>
}

/** Starts a complete `defineStaticRuntime()` application and resolves after cold boot settles. */
export async function startStaticApplicationTestHost<
	const TPlugins extends readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<TPlugins, TBindings>,
	...optionsTuple: {} extends TBindings
		? [options?: StaticApplicationTestHostOptions<TBindings>]
		: [options: StaticApplicationTestHostOptions<TBindings>]
): Promise<StaticApplicationTestHost<TPlugins>> {
	const options = optionsTuple[0]
	const runtime = await startStaticRuntimeApplication(application, {
		startup: {
			mode: 'test',
			env: options?.env ?? {},
			bindings: options?.bindings ?? ({} as TBindings),
		},
		createWorkbenchBackend,
	})
	const registry = requirePluginService(runtime.ctx)
	const implementations = new Set<PluginConstructor>(application.plugins)
	type Target = StaticPluginTestTarget<TPlugins>
	const resolveTarget = (target: Target) => {
		const resolved = resolvePluginTestTarget(target as PluginTestTarget)
		if (!implementations.has(resolved.implementation)) {
			throw new TypeError(
				'[runtime-static/test] Plugin target is outside this application fixed catalog',
			)
		}
		return assertPluginTestTargetCurrent(registry, target as PluginTestTarget, {
			allowAbsent: true,
		})
	}
	let drivers
	try {
		drivers = createRuntimeTestDriverScope<Target>({
			ctx: runtime.ctx as RootContext,
			resolveTarget,
		})
	} catch (error) {
		try {
			await runtime.stop()
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'[runtime-static/test] driver setup and application cleanup both failed',
				{ cause: cleanupError },
			)
		}
		throw error
	}

	let disposePromise: Promise<void> | undefined
	const dispose = () => (disposePromise ??= disposeStaticApplicationTestHost(drivers, runtime.stop))
	const requirePlugin = <TTarget extends Target>(target: TTarget): PluginInstanceFor<TTarget> => {
		drivers.assertQuery('require')
		const instance = registry.getInstance(resolveTarget(target))
		if (!instance) {
			throw new Error('[runtime-static/test] Plugin target is not running')
		}
		return instance as PluginInstanceFor<TTarget>
	}
	return Object.freeze({
		startupReport: runtime.startupReport,
		config: drivers.config,
		http: drivers.http,
		commands: drivers.commands,
		workbench: drivers.workbench,
		require: requirePlugin,
		isRunning(target: Target) {
			drivers.assertQuery('isRunning')
			return registry.isRunning(resolveTarget(target))
		},
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
}

async function disposeStaticApplicationTestHost(
	drivers: AsyncDisposable & { dispose(): Promise<void> },
	stopRuntime: () => Promise<void>,
): Promise<void> {
	const errors: unknown[] = []
	try {
		await drivers.dispose()
	} catch (error) {
		errors.push(error)
	}
	try {
		await stopRuntime()
	} catch (error) {
		errors.push(error)
	}
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) {
		throw new AggregateError(errors, '[runtime-static/test] application cleanup failed')
	}
}
