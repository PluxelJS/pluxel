import { defineHostApplication } from '@pluxel/host/application'
import { demoConfig } from './demo-config'

export function demoApplication({
	Provider,
	Consumer,
}: typeof import('@pluxel-example/host-targets-plugins')) {
	return defineHostApplication(({ env }) => {
		const source = env.GREETING_SOURCE
		if (!source) throw new Error('GREETING_SOURCE is required')
		const { provider, consumer } = demoConfig(source)
		return {
			plugins: [
				{ plugin: Provider, ...provider },
				{ plugin: Consumer, ...consumer },
			],
		}
	})
}
