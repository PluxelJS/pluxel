export {}

const port = process.parentPort
if (!port) throw new Error('Studio backend must run in an Electron utility process')
const [root, assetsRoot] = process.argv.slice(2)
if (!root || !assetsRoot) throw new Error('Studio backend requires data and asset roots')
if (process.env.STUDIO_DEV === '1' && !process.env.STUDIO_PROJECT_ROOT)
	throw new Error('Studio development requires STUDIO_PROJECT_ROOT')
let backend: Awaited<ReturnType<typeof import('../backend/runtime.ts').startBackend>>
if (process.env.STUDIO_DEV === '1') {
	const { startDevBackend } = await import('../backend/dev.ts')
	backend = await startDevBackend({ root, assetsRoot }, process.env.STUDIO_PROJECT_ROOT!)
} else {
	const { startBackend } = await import('../backend/runtime.ts')
	backend = await startBackend({ root, assetsRoot })
}
let closing = false
port.on('message', ({ data, ports }) => {
	if (data?.type === 'close') {
		if (closing) return
		closing = true
		void backend.close().then(
			() => port.postMessage({ type: 'closed' }),
			(error) => port.postMessage({ type: 'closed', error: String(error) }),
		)
		return
	}
	if (closing || !['desktop-port', 'native-port'].includes(data?.type) || ports.length !== 1) {
		for (const connection of ports) connection.close()
		return
	}
	backend.connectDesktopPort(ports[0]!, { native: data.type === 'native-port' })
})
port.postMessage({ type: 'ready' })
