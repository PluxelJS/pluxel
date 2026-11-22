import type { ViteHotContext } from 'vite/types/hot.js'

type Host = { close(): Promise<void> }
const owner = Symbol.for('@pluxel/host-vite/hmr/host')

/** Register the module's Host and await retirement of its previous evaluation, including virtual reimports. */
export async function closeOnHotReload(
	hot: Pick<ViteHotContext, 'data' | 'dispose' | 'on'>,
	host: Host,
): Promise<void> {
	const data: { [owner]?: { host: Host; ready?: Promise<void>; close(): Promise<void> } } = hot.data
	const previous = data[owner]
	const ready = previous?.host === host ? previous.ready : previous?.close()
	const release = async () => host.close()
	const close = () => (ready ? ready.then(release, release) : release())
	// Publish before awaiting: another evaluation can start while a prior Host drains.
	data[owner] = { host, ready, close }
	hot.dispose(close)
	hot.on('vite:beforeFullReload', close)
	try {
		await ready
	} catch (error) {
		// Evaluation failed, so its newly supplied Host has no application to own it.
		try {
			await release()
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], '[host-vite] Host reload cleanup failed')
		}
		throw error
	}
}
