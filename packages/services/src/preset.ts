import { resolve } from 'node:path'
import type { HostService, HostStartupContext } from '@pluxel/host'
import type { RuntimeLoggingInput } from './logging/index'
import type { ProductDescriptor } from './management/product-contract'
import type { PersistenceServiceConfig } from './persistence'
import { standardServices } from './index'
import { vault, type VaultServiceConfig } from './vault'

/** Official application services. Host owns preparation, rollback and shutdown. */
export async function servicesPreset(
	startup: HostStartupContext,
	options: Readonly<{
		persistence: PersistenceServiceConfig
		/** Explicit Vault backend and legacy owner assignments. */
		vault?: VaultServiceConfig
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
	const [
		{ logging },
		{ managementAccess },
		{ management },
		{ managementCommands },
		{ managementHttp },
	] = await Promise.all([
		import('./logging/index'),
		import('./management/access'),
		import('./management/service'),
		import('./management/commands'),
		import('./management/http'),
	])
	const workbench = withWorkbench
		? await Promise.all([
				import('@pluxel/workbench/service'),
				import('@pluxel/workbench/http'),
				import('@pluxel/workbench/server'),
			]).then(
				([
					{ workbenchService },
					{ workbenchHttp },
					{ requireWorkbench, createWorkbenchArtifactHandler, WorkbenchHost },
				]) => ({
					workbenchService,
					workbenchHttp,
					requireWorkbench,
					createWorkbenchArtifactHandler,
					WorkbenchHost,
				}),
			)
		: undefined
	const managementTransport = managementHttp(
		workbench
			? {
					bindings: (ctx) => ({
						createWorkbench: (principal, invalidate) =>
							workbench.requireWorkbench(ctx).createSession(principal, invalidate),
						artifacts: workbench.createWorkbenchArtifactHandler(ctx),
					}),
				}
			: {},
	)
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
		vault({ deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY, ...options.vault }),
		managementAccess(),
		managementCommands(),
		workbench
			? {
					...managementTransport,
					requires: { ...managementTransport.requires, workbench: workbench.WorkbenchHost },
				}
			: managementTransport,
		management({ application: { product: options.product ?? null }, workbench: withWorkbench }),
		...(workbench
			? [
					workbench.workbenchService({
						product: options.product,
						artifacts: deployment ? { root: resolve(deployment.root, 'workbench') } : undefined,
					}),
					workbench.workbenchHttp({
						uiBasePath: '/__pluxel/workbench',
						publicDir: deployment ? resolve(deployment.root, 'workbench/public') : undefined,
					}),
				]
			: []),
	]
}
