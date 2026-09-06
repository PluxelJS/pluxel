import { staticRuntimeVitePlugin } from '../../src/vite.ts'
import { exerciseViteConsole } from '../../../runtime-dev/tests/support/vite-console-scenario.mts'
await exerciseViteConsole({
	route: 'static',
	root: process.env.PLUXEL_CONSOLE_FIXTURE_ROOT!,
	plugins: (entry, devConsole) => staticRuntimeVitePlugin({ entry, devConsole }),
})
