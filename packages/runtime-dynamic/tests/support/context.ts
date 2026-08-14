import '@pluxel/runtime'
import '../../src/register-services'

import { createHost, type Host } from '@pluxel/test'
import type { Context } from '@pluxel/core'

export function createTestDynamicHost(config: Context.Config = {}): Host {
	return createHost({
		persistence: { mode: 'memory' },
		configService: { mode: 'memory' },
		runtimeState: { mode: 'memory' },
		...config,
	})
}

export async function withTestDynamicContext<T>(
	fn: (ctx: Context, host: Host) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const host = createTestDynamicHost(config)
	try {
		return await fn(host.ctx, host)
	} finally {
		await host.dispose()
	}
}
