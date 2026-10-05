import { runViteApplication } from '@pluxel/host-vite/run'

const session = await runViteApplication({
	root: import.meta.dirname,
	configFile: 'vite.runtime.config.ts',
})
for (const signal of ['SIGINT', 'SIGTERM'])
	process.once(signal, () => {
		void session.close().catch((error) => {
			console.error(error)
			process.exitCode = 1
		})
	})
