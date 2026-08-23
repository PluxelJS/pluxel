import '@pluxel/runtime'
import type { Context } from '@pluxel/core'
import type { RuntimeHostConfig } from '@pluxel/runtime/internal/static-host'
import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import { createDynamicRouteContextCapabilities } from '../../src/context-plan'

export function createTestDynamicHost(config: RuntimeHostConfig = {}): RuntimeHost {
	return createRuntimeHost(
		{
			workbench: false,
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			...config,
		},
		{ routeContextCapabilities: createDynamicRouteContextCapabilities() },
	)
}

export async function withTestDynamicContext<T>(
	fn: (ctx: Context, host: RuntimeHost) => Promise<T> | T,
	config: RuntimeHostConfig = {},
): Promise<T> {
	const host = createTestDynamicHost(config)
	try {
		return await fn(host.ctx, host)
	} finally {
		await host.dispose()
	}
}
