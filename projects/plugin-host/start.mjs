import { runHostApplication } from '@pluxel/host'
import { serviceSharedPackages } from '@pluxel/services/sources'
import { fileURLToPath } from 'node:url'

const startupEnv = Object.freeze({ ...process.env })
const host = await runHostApplication(fileURLToPath(new URL('./dist/app.mjs', import.meta.url)), {
	startup: { root: import.meta.dirname, mode: 'production', env: startupEnv, bindings: {} },
	sharedPackages: serviceSharedPackages,
})
export const stop = () => host.close()
