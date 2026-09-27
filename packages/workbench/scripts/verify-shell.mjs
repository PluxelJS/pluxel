import { createWorkbenchShellHandler } from '../dist/shell.mjs'

const shell = await createWorkbenchShellHandler()
const response = await shell(
	new Request('http://localhost/__pluxel/workbench/assets/nonexistent.js'),
)
if (response?.status !== 404) throw new Error('Packaged Shell asset routing failed')
