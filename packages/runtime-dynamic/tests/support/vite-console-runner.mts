import { dynamicRuntimeVitePlugin } from '../../src/vite.ts'
import { exerciseViteConsole } from '../../../runtime-dev/tests/support/vite-console-scenario.mts'
await exerciseViteConsole({
	route: 'dynamic',
	root: process.env.PLUXEL_CONSOLE_FIXTURE_ROOT!,
	plugins: (entry, devConsole) => dynamicRuntimeVitePlugin({ entry, devConsole }),
	dynamicConfigImport: new URL('../../src/index.ts', import.meta.url).href,
})
