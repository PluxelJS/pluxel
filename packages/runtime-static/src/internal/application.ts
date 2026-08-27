import type { PluginConstructor } from '@pluxel/core'
import { isWorkbenchEnabled } from '@pluxel/runtime/internal/static-host'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { isStaticRuntimeApplication, resolveStaticRuntimeHostOptions } from '../application'
import { createStaticRuntimeHost, type StaticRuntimeHostDeployment } from './host'
import type { WorkbenchBackendFactory } from '@pluxel/runtime/internal/static'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDefinition,
	StaticRuntimeStartupContext,
} from '../types'

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
	const hostOptions = await resolveStaticRuntimeHostOptions(application, options.startup)
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
	try {
		await application.prepare?.({ host, startup: options.startup })
		await host.start()
	} catch (error) {
		await host.stop().catch((): undefined => undefined)
		throw error
	}

	return {
		ctx: host.ctx,
		fetch: (request, env, ctx) => host.fetch(request, env, ctx),
		start: () => host.start(),
		stop: () => host.stop(),
	}
}

export function toStaticRuntimeDefinition(
	application: Pick<StaticRuntimeApplication, 'name' | 'plugins'>,
): StaticRuntimeDefinition {
	return {
		name: application.name,
		plugins: application.plugins,
	}
}
