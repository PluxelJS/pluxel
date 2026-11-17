import { createRoot } from 'react-dom/client'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source/browser'
import type { ExampleId } from './examples'
import type { WorkspaceFolders } from './file-explorer'
import type { sourceExample } from './source-example'
import { Workspace, createTypstWorkspace, storageKeys } from './workspace'
import 'flexlayout-react/style/light.css'
import '@worksplit/react/style.css'
import '@pluxel/plugin-typst/tiptap/style.css'
import './style.css'
import './document-style.css'

async function start() {
	const response = await fetch('/workspace')
	if (!response.ok) throw new Error(await response.text())
	const seeds = (await response.json()) as Record<
		ExampleId,
		Awaited<ReturnType<typeof sourceExample>>
	>
	const folders = {} as WorkspaceFolders
	for (const example of Object.keys(seeds) as ExampleId[]) {
		const seed = seeds[example]
		const saved = localStorage.getItem(storageKeys[example])
		const files = saved ? (JSON.parse(saved) as Record<string, string>) : seed.files
		folders[example] = {
			initialFiles: seed.files,
			project: await createTypstSourceProject({
				files,
				components: seed.components,
				writablePaths: [
					...seed.writablePaths,
					...Object.keys(files).filter((path) => !Object.hasOwn(seed.files, path)),
				],
				parserWasm,
			}),
		}
	}
	const root = createRoot(document.getElementById('root')!)
	let issue = ''
	const workbench = createTypstWorkspace((message) => {
		issue = message
		render()
	})
	function render() {
		root.render(<Workspace folders={folders} workbench={workbench} issue={issue} />)
	}
	const started = await workbench.start()
	if (started.status !== 'applied') {
		await workbench.dispose()
		throw new Error(`Workspace startup: ${started.status}`)
	}
	const dispose = () => {
		root.unmount()
		void workbench.dispose()
	}
	window.addEventListener('pagehide', dispose, { once: true })
	if (import.meta.hot) import.meta.hot.dispose(dispose)
	render()
}
void start().catch((error) => {
	document.getElementById('root')!.textContent = String(error)
})
