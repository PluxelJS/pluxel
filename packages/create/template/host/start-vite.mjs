import { fileURLToPath } from 'node:url'
import { runViteApplication } from '@pluxel/host-vite/run'

const session = await runViteApplication({
	root: fileURLToPath(new URL('.', import.meta.url)),
	configFile: 'vite.runtime.config.ts',
})
for (const signal of ['SIGINT', 'SIGTERM'])
	process.once(signal, () => {
		void session.close().catch((error) => {
			console.error(error)
			process.exitCode = 1
		})
	})
