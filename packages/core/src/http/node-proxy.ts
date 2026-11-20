import { isNode, isWorkerd } from 'std-env'
import type { Dispatcher } from 'undici'

/** The legacy Core assembly keeps Undici lazy and uses the native Node Fetch dispatcher. */
async function createProxyDispatcher(url: string): Promise<Dispatcher> {
	const moduleName: string = 'undici'
	const { ProxyAgent, Dispatcher1Wrapper } = (await import(
		/* @vite-ignore */ moduleName
	)) as typeof import('undici')
	const agent = new ProxyAgent(url)
	// Node 24's built-in Fetch still uses the legacy Dispatcher handler protocol.
	return Number.parseInt(process.versions.undici ?? '0', 10) < 8
		? new Dispatcher1Wrapper(agent)
		: agent
}

export const nativeProxyDispatcherFactory = isNode && !isWorkerd ? createProxyDispatcher : undefined
