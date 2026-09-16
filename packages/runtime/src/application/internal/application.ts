import {
	installPluginSources,
	openPluginSources,
	collectPluginModuleExports,
} from '@pluxel/host/internal'
import { createProductionSourceLoader } from './production-source-loader'
import type { PluginConstructor } from '@pluxel/core'
import { isWorkbenchEnabled } from '../../internal-static-host.ts'
import type { ProductDescriptor } from '../../product.ts'
import { assertRuntimeApplication, resolveRuntimeHostOptions } from '../application.ts'
import { createRuntimeHost, type RuntimeHostDeployment } from './host.ts'
import type { WorkbenchBackendFactory } from '../../internal-static.ts'
import type {
	Runtime,
	RuntimeApplication,
	RuntimeBindings,
	RuntimeDefinition,
	RuntimeStartupReport,
	RuntimeStartupContext,
} from '../types.ts'

export type StartRuntimeApplicationOptions<TBindings extends RuntimeBindings = RuntimeBindings> = {
	startup: RuntimeStartupContext<TBindings>
	deployment?: RuntimeHostDeployment
	createWorkbenchBackend?: WorkbenchBackendFactory
	product?: ProductDescriptor | null
	frameworkModules?: Readonly<Record<string, string>>
}

export async function startRuntimeApplication<TBindings extends RuntimeBindings = RuntimeBindings>(
	application: RuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: StartRuntimeApplicationOptions<TBindings>,
): Promise<Runtime> {
	assertRuntimeApplication(application)
	const hostOptions = await resolveRuntimeHostOptions(application, options.startup, {
		workbench: options.deployment?.workbenchIncluded === true,
	})
	if (
		isWorkbenchEnabled(hostOptions.workbench) &&
		options.deployment?.workbenchIncluded === false
	) {
		throw new Error(
			'[runtime] This application was built as headless and cannot enable Workbench at startup',
		)
	}
	let host: Awaited<ReturnType<typeof createRuntimeHost>> | undefined
	let sources: Awaited<ReturnType<typeof openPluginSources>> | undefined
	const startupBarrier = Promise.withResolvers<void>()
	let sourceTail = Promise.resolve()
	let closing = false
	let initialSnapshotEstablished = false
	let discoveryError: unknown
	let stopping: Promise<void> | undefined
	const loader = createProductionSourceLoader(options.frameworkModules)
	let modules = new Map<string, readonly PluginConstructor[]>()
	const load = async (path: string): Promise<readonly PluginConstructor[]> =>
		collectPluginModuleExports(await loader.load(path))
	const combined = (
		candidate: ReadonlyMap<string, readonly PluginConstructor[]>,
	): RuntimeDefinition => ({
		name: application.name,
		plugins: [
			...application.plugins,
			...[...candidate.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.flatMap(([, plugins]) => plugins),
		],
	})
	const stop = (): Promise<void> => {
		closing = true
		startupBarrier.resolve()
		return (stopping ??= (async () => {
			const errors: unknown[] = []
			try {
				await sources?.close()
			} catch (error) {
				errors.push(error)
			}
			await sourceTail
			try {
				await host?.stop()
			} catch (error) {
				errors.push(error)
			}
			loader.close()
			if (errors.length > 0)
				throw new AggregateError(errors, '[runtime] application shutdown failed')
		})())
	}
	let startupReport: RuntimeStartupReport
	try {
		sources = await openPluginSources({
			root: options.startup.root,
			sources: application.sources ?? [],
			onError(error) {
				if (host) host.ctx.logger.error('Plugin source discovery failed', { error })
				else discoveryError = error
			},
			onChange(change) {
				if (closing || !initialSnapshotEstablished) return
				const task = sourceTail.then(async (): Promise<void> => {
					await startupBarrier.promise
					if (closing) return undefined
					const candidate = new Map(modules)
					if (change.type === 'unlink') candidate.delete(change.path)
					else candidate.set(change.path, await load(change.path))
					if (closing) return undefined
					const result = await host!.applyDefinitionUpdate(combined(candidate), performance.now())
					if (result.status === 'applied' || result.catalogCommitted) modules = candidate
					if (result.status === 'failed') throw result.error
					return undefined
				})
				sourceTail = task.catch((error) => {
					host?.ctx.logger.error('Plugin source update failed', { error })
				})
			},
		})
		// Establish the full initial catalog before any required consumer is activated.
		const initialEntries = sources.entries()
		initialSnapshotEstablished = true
		for (const path of initialEntries) modules.set(path, await load(path))
		if (discoveryError) throw discoveryError
		host = await createRuntimeHost(combined(modules), hostOptions, {
			deployment: options.deployment,
			createWorkbenchBackend: options.createWorkbenchBackend,
			product: options.product ?? null,
		})
		installPluginSources(host.ctx, {
			root: options.startup.root,
			sources: application.sources ?? [],
		})
		await application.prepare?.({ host, startup: options.startup })
		if (discoveryError) throw discoveryError
		startupReport = await host.start()
		startupBarrier.resolve()
	} catch (error) {
		try {
			await stop()
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'[runtime] application startup and cleanup both failed',
				{ cause: cleanupError },
			)
		}
		throw error
	}

	return {
		ctx: host.ctx,
		startupReport: freezeRuntimeStartupReport(startupReport),
		fetch: (request, env, ctx) => host.fetch(request, env, ctx),
		start: () => host.start(),
		stop,
	}
}

function freezeRuntimeStartupReport(report: Runtime['startupReport']): Runtime['startupReport'] {
	return Object.freeze({
		runtime: report.runtime,
		entries: Object.freeze(report.entries.map((entry) => Object.freeze({ ...entry }))),
	})
}

export function toRuntimeDefinition(
	application: Pick<RuntimeApplication, 'name' | 'plugins'>,
): RuntimeDefinition {
	return {
		name: application.name,
		plugins: application.plugins,
	}
}
