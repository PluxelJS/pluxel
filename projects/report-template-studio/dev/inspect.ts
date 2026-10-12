import { defineDevConsole } from '@pluxel/host-vite/console'

export default defineDevConsole(async (dev) => ({
	plugins: await dev.plugins.list(),
	update: await dev.updates.latest(),
}))
