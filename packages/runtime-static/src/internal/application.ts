import type { PluginConstructor } from '@pluxel/core'
import { isWorkbenchEnabled } from '@pluxel/runtime/internal/static-host'
import { isStaticRuntimeApplication, resolveStaticRuntimeHostOptions } from '../application'
import {
	createStaticRuntimeHost,
	type StaticRuntimeHostDeployment,
	type StaticRuntimeWorkbenchInstaller,
} from './host'
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
	installWorkbench?: StaticRuntimeWorkbenchInstaller
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
		installWorkbench: options.installWorkbench,
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
		fetch: (request, env, ctx) => host.ctx.http.fetch(request, env, ctx),
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
