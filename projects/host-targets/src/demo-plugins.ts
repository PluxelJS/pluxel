import { defineHostApplication } from '@pluxel/host/application'
import type { OutboundFetch } from '@pluxel/core'
import { createScriptScope } from '@pluxel/agent-sdk/host'
import type { DemoHost } from './protocol'
import { demoConfig } from './demo-config'

const expectedSource = {
	node: 'Node Fetch transport',
	browser: 'Browser Fetch',
	cloudflare: 'workerd Service Binding',
}

export function demoInputs(
	env: Readonly<{ GREETING_SOURCE: string; HOST_PROBE?: string }>,
	fetch?: OutboundFetch,
) {
	return {
		env,
		coreConfig: {
			...demoConfig(env.GREETING_SOURCE, fetch).coreConfig,
			vault: { backend: 'bindings' as const },
		},
	}
}

export function demoApplication(
	{
		Provider,
		Consumer,
	}: Pick<typeof import('@pluxel-example/host-targets-plugins'), 'Provider' | 'Consumer'>,
	target: DemoHost,
) {
	return defineHostApplication(async ({ env }) => {
		const source = env.GREETING_SOURCE
		if (!source) throw new Error('GREETING_SOURCE is required')
		if (import.meta.env.PROD && env.HOST_PROBE !== undefined) {
			const probe = await import('@pluxel-example/host-targets-plugins/probe')
			return {
				plugins: probe.probePlugins(source, { Provider, Consumer }),
				async launch({ host }) {
					await using scope = createScriptScope({ ctx: host.ctx })
					await probe.inspectHost(scope.sdk, {
						sourceUrl: source,
						expectedSource: expectedSource[target],
						sessionFiles: target === 'cloudflare' ? 'ENOTSUP' : 'read-write',
					})
				},
			}
		}
		const { provider, consumer } = demoConfig(source)
		return {
			plugins: [
				{ plugin: Provider, ...provider },
				{ plugin: Consumer, ...consumer },
			],
		}
	})
}
