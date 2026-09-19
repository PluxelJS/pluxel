import type { RootCapabilityInstallation } from '@pluxel/core/host'
import { createHost, defineHostService, type PluginHost, type HostService } from '@pluxel/host'
import type { ServiceInternalTestHostOptions } from './options'

export type ServiceInternalTestRootOptions = Readonly<{
	/** Framework test-only installation of capabilities before the root is created. */
	capabilities?: readonly RootCapabilityInstallation<unknown, undefined>[]
	/** Simulated physical peer for in-process Management HTTP tests. Defaults to loopback. */
	requestAddress?: (request: Request) => Readonly<{ address: string }> | null
}>

export async function createServiceTestApplication(
	options: ServiceInternalTestHostOptions = {},
	internal: ServiceInternalTestRootOptions = {},
): Promise<PluginHost> {
	const withWorkbench = options.workbench ?? false
	const withManagement = options.management ?? withWorkbench
	if (typeof withWorkbench !== 'boolean' || typeof withManagement !== 'boolean') {
		throw new TypeError('[pluxel/test] workbench and management must be booleans')
	}
	if (withWorkbench && !withManagement) {
		throw new TypeError('[pluxel/test] Workbench requires Management')
	}
	let selectedServices = options.services
	if (selectedServices === undefined) {
		const { standardServices } = await import('@pluxel/services')
		selectedServices = standardServices({ persistence: { mode: 'memory' } })
	}
	const services: HostService[] = [...selectedServices]
	if (withManagement) {
		const [{ managementAccess }, { management }] = await Promise.all([
			import('@pluxel/management/access'),
			import('@pluxel/management/service'),
		])
		services.push(managementAccess(), management({ workbench: withWorkbench }))
	}
	if (withWorkbench) {
		const { testWorkbenchService } = await import('@pluxel/workbench/internal/test')
		services.push(testWorkbenchService())
	}
	const { HttpServer } = withManagement
		? await import('@pluxel/services/http')
		: { HttpServer: undefined }

	services.push(
		defineHostService({
			name: 'Service test transport',
			requires: withManagement ? { http: HttpServer } : {},
			capabilities: internal.capabilities ?? [],
			async prepare({ ctx, effects }) {
				if (!withManagement) return
				const { attachManagementHttp } = await import('@pluxel/management/internal/http')
				const workbench = withWorkbench ? await import('@pluxel/workbench/server') : undefined
				attachManagementHttp(
					ctx,
					effects,
					withWorkbench
						? {
								bindings: () => ({
									createWorkbench: (principal, identity) =>
										workbench!.requireWorkbench(ctx).createSession(principal, identity),
									artifacts: workbench!.createWorkbenchArtifactHandler(ctx),
								}),
							}
						: {},
					{
						requestPeer: (request) => {
							const url = new URL(request.url)
							return {
								address: internal.requestAddress
									? internal.requestAddress(request)?.address
									: '127.0.0.1',
								secure: url.protocol === 'https:',
								origin: url.origin,
							}
						},
					},
				)
			},
		}),
	)
	return createHost({
		plugins: [],
		config: { name: 'test', ...options.config },
		services,
		state: options.state,
		configRecords: options.configRecords,
	})
}
