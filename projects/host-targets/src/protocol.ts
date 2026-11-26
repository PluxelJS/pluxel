import type { Greeting } from '@pluxel-example/host-targets-plugins'

export type DemoHost = 'node' | 'browser' | 'cloudflare'

export type DemoResult = Greeting & {
	host: DemoHost
	plugin: string
}

export type DemoUpdate = { host: DemoHost; error?: string }

export const demoUpdateEvent = 'host-targets:update'
