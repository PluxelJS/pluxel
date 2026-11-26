import type { OutboundFetch } from '@pluxel/core'

export const nodeSource = 'https://greetings.example.invalid/'
export const nodeFetch = async () => Response.json({ source: 'Node Fetch transport' })

export function demoConfig(source: string, name?: string, fetch?: OutboundFetch) {
	return {
		config: name === undefined ? { source } : { source, name },
		coreConfig: {
			http: { allowedOrigins: [new URL(source).origin], records: 'off' as const, fetch },
		},
	}
}
