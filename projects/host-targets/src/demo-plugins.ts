import { defineHostApplication } from '@pluxel/host/application'
import type { OutboundFetch } from '@pluxel/core'
import { demoConfig } from './demo-config'

export function demoApplication(
	{
		Provider,
		Consumer,
	}: Pick<typeof import('@pluxel-example/host-targets-plugins'), 'Provider' | 'Consumer'>,
	fetch?: OutboundFetch,
) {
	return defineHostApplication(({ env }) => {
		const source = env.GREETING_SOURCE
		if (!source) throw new Error('GREETING_SOURCE is required')
		const { config, coreConfig } = demoConfig(source, env.GREETING_NAME, fetch)
		return {
			coreConfig,
			plugins: [
				{ plugin: Provider, config },
				{ plugin: Consumer, autoStart: true },
			],
		}
	})
}
