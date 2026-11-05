import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// Observe the deployed process, including imports made by the native source loader.
const unselected =
	/\/node_modules\/(?:@pluxel\/(?:workbench|commands|rolldown|host-vite)|vite(?:-plus)?|rolldown|pg(?:-pool)?|@electric-sql\/pglite)(?:\/|$)/
registerHooks({
	load(url, context, next) {
		if (url.startsWith('file:')) {
			const path = fileURLToPath(url)
			if (unselected.test(path)) throw new Error(`Unselected runtime package: ${url}`)
			if (process.env.FORBIDDEN_ROOT && path.startsWith(process.env.FORBIDDEN_ROOT + '/'))
				throw new Error(`Runtime escaped its delivery: ${url}`)
		}
		return next(url, context)
	},
})
