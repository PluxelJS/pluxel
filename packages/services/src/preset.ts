import { resolve } from 'node:path'
import type { HostService, HostStartupContext } from '@pluxel/host'
import type { ProductDescriptor } from './management/product-contract'
import type { WorkbenchShortcut } from '@pluxel/workbench/service'
import { standardServices } from './index'
import { vault, type VaultServiceConfig } from './vault'

/** Official application services. Host owns preparation, rollback and shutdown. */
export async function servicesPreset(
	startup: HostStartupContext,
	options: Readonly<{
		/** Explicit Vault backend and deployment identity. */
		vault?: VaultServiceConfig
		/** Omitted when the application has no product branding. */
		product?: ProductDescriptor
		/** Include the Workbench UI at /__pluxel/workbench. @default true */
		workbench?: boolean
		/** Explicitly grant authenticated administrators trusted Node script execution. @default false */
		scripts?: boolean
		/** Initial user-removable sidebar shortcuts; declarations never control root placement. */
		initialShortcuts?: readonly WorkbenchShortcut[]
	}>,
): Promise<HostService[]> {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[services/preset] options must be an object')
	for (const key of Object.keys(options)) {
		if (!['vault', 'product', 'workbench', 'scripts', 'initialShortcuts'].includes(key))
			throw new TypeError(`[services/preset] Unknown option options.${key}`)
	}
	if (options.workbench !== undefined && typeof options.workbench !== 'boolean')
		throw new TypeError('[services/preset] options.workbench must be a boolean')
	if (options.scripts !== undefined && typeof options.scripts !== 'boolean')
		throw new TypeError('[services/preset] options.scripts must be a boolean')
	const withWorkbench = options.workbench ?? true
	const deployment = startup.deployment
	const nodeModules =
		deployment?.delivery === 'standalone'
			? { root: resolve(deployment.root, 'artifacts/node') }
			: undefined
	const [{ managementAccess }, { management }, { managementCommands }, { managementHttp }] =
		await Promise.all([
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
	const managementTransport = managementHttp({
		scripts: options.scripts,
		...(workbench
			? {
					bindings: (ctx) => ({
						createWorkbench: (principal, invalidate) =>
							workbench.requireWorkbench(ctx).createSession(principal, invalidate),
						artifacts: workbench.createWorkbenchArtifactHandler(ctx),
					}),
				}
			: {}),
	})
	return [
		...standardServices({ nodeModules }),
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
						initialShortcuts: options.initialShortcuts,
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
