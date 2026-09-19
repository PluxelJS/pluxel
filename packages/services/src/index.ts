import { resolve } from 'node:path'
import type { HostService, HostStartupContext } from '@pluxel/host'
import type { RuntimeLoggingInput } from '@pluxel/logging'
import { vault } from './vault'
import type { ProductDescriptor } from '@pluxel/management/product'

import { http } from './http'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers } from './workers'
import { persistence, type PersistenceServiceConfig } from './persistence'

/** The default server service list is explicit and fixed; optional Database, Vault, logging backends and Management are composed separately. */
export function standardServices(
	options: Readonly<{
		persistence: PersistenceServiceConfig
		/** Production artifact location; development attaches its compiler separately. */
		nodeModules?: NodeModuleArtifactHostOptions
	}>,
): readonly HostService[] {
	return [
		http(),
		commands(),
		nodeModules(options.nodeModules),
		workers(),
		persistence(options.persistence),
	] as const
}

/** Official application services. Host owns preparation, rollback and shutdown. */
export async function servicesPreset(
	startup: HostStartupContext,
	options: Readonly<{
		persistence: PersistenceServiceConfig
		/** Omitted when the application has no product branding. */
		product?: ProductDescriptor
		/** Include the Workbench UI at /__pluxel/workbench. @default true */
		workbench?: boolean
		/** Complete logging plan override; defaults to a pretty console and bounded memory store. */
		logging?: RuntimeLoggingInput
	}>,
): Promise<HostService[]> {
	const withWorkbench = options.workbench ?? true
	const deployment = startup.deployment
	const [{ logging }, { managementAccess }, { management }, { managementCommands }] =
		await Promise.all([
			import('@pluxel/logging'),
			import('@pluxel/management/access'),
			import('@pluxel/management/service'),
			import('@pluxel/management/commands'),
		])
	const workbench = withWorkbench
		? await Promise.all([import('@pluxel/workbench/service'), import('@pluxel/workbench/http')])
		: undefined
	return [
		logging(
			options.logging ?? {
				root: { profile: 'pluxel' },
				sinks: {
					console: { kind: 'console', format: 'pretty', caller: false, timezone: 'local' },
					store: { kind: 'store', streamId: 'default', caller: true },
				},
				routes: {
					runtime: [
						{ sink: 'console', minLevel: 'info' },
						{ sink: 'store', minLevel: 'trace' },
					],
					plugins: [
						{ sink: 'console', minLevel: 'info' },
						{ sink: 'store', minLevel: 'trace' },
					],
					debug: [{ sink: 'store', minLevel: 'trace' }],
					meta: [{ sink: 'console', minLevel: 'warning' }],
				},
			},
		),
		...standardServices({
			persistence: options.persistence,
			nodeModules: deployment ? { root: resolve(deployment.root, 'artifacts/node') } : undefined,
		}),
		vault(),
		managementAccess(),
		managementCommands(),
		management({ application: { product: options.product ?? null }, workbench: withWorkbench }),
		...(workbench
			? [
					workbench[0].workbenchService({
						product: options.product,
						artifacts: deployment ? { root: resolve(deployment.root, 'workbench') } : undefined,
					}),
					workbench[1].workbenchHttp({
						uiBasePath: '/__pluxel/workbench',
						publicDir: deployment ? resolve(deployment.root, 'workbench/public') : undefined,
					}),
				]
			: []),
	]
}
