import type { PluginConstructor } from '@pluxel/core'
import { isWorkbenchEnabled } from '@pluxel/runtime/internal/static-host'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { isStaticRuntimeApplication, resolveStaticRuntimeHostOptions } from '../application.ts'
import { createStaticRuntimeHost, type StaticRuntimeHostDeployment } from './host.ts'
import type { WorkbenchBackendFactory } from '@pluxel/runtime/internal/static'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDefinition,
	StaticRuntimeStartupReport,
	StaticRuntimeStartupContext,
} from '../types.ts'

export type StartStaticRuntimeApplicationOptions<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
> = {
	startup: StaticRuntimeStartupContext<TBindings>
	deployment?: StaticRuntimeHostDeployment
	createWorkbenchBackend?: WorkbenchBackendFactory
	product?: ProductDescriptor | null
}

export async function startStaticRuntimeApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: StartStaticRuntimeApplicationOptions<TBindings>,
): Promise<StaticRuntime> {
	if (!isStaticRuntimeApplication(application)) {
		throw new TypeError(
			'[runtime-static] Application must be created with defineStaticRuntime(...)',
		)
	}
	const hostOptions = await resolveStaticRuntimeHostOptions(application, options.startup, {
		workbench: options.deployment?.workbenchIncluded === true,
	})
	if (
		isWorkbenchEnabled(hostOptions.workbench) &&
		options.deployment?.workbenchIncluded === false
	) {
		throw new Error(
			'[runtime-static] This application was built as headless and cannot enable Workbench at startup',
		)
	}
	const host = await createStaticRuntimeHost(toStaticRuntimeDefinition(application), hostOptions, {
		deployment: options.deployment,
		createWorkbenchBackend: options.createWorkbenchBackend,
		product: options.product ?? null,
	})
	let startupReport: StaticRuntimeStartupReport
	try {
		await application.prepare?.({ host, startup: options.startup })
		startupReport = await host.start()
	} catch (error) {
		try {
			await host.stop()
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'[runtime-static] application startup and cleanup both failed',
				{ cause: cleanupError },
			)
		}
		throw error
	}

	return {
		ctx: host.ctx,
		startupReport: freezeStaticRuntimeStartupReport(startupReport),
		fetch: (request, env, ctx) => host.fetch(request, env, ctx),
		start: () => host.start(),
		stop: () => host.stop(),
	}
}

function freezeStaticRuntimeStartupReport(
	report: StaticRuntime['startupReport'],
): StaticRuntime['startupReport'] {
	return Object.freeze({
		runtime: report.runtime,
		entries: Object.freeze(report.entries.map((entry) => Object.freeze({ ...entry }))),
	})
}

export function toStaticRuntimeDefinition(
	application: Pick<StaticRuntimeApplication, 'name' | 'plugins'>,
): StaticRuntimeDefinition {
	return {
		name: application.name,
		plugins: application.plugins,
	}
}
