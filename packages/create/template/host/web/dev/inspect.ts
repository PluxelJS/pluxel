import type { ProjectScript } from '@pluxel/host-vite/project'
import { TodoPlugin } from '@example/todo-plugin'

/** Locate the current disk declaration, Schema and application input without changing the Host. */
export default ((sdk) =>
	sdk.inspect(TodoPlugin.definitionAddress(), {
		include: ['config', 'parts', 'inputs', 'checks'],
	})) satisfies ProjectScript
