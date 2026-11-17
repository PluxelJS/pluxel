import { contextBridge, ipcRenderer } from 'electron'
import type { StudioBridge } from '../shared/contracts.ts'

const bridge: StudioBridge = {
	onBeforeClose(decide) {
		const request = () => {
			void decide().then(
				(allowed) => ipcRenderer.send('studio:close-result', allowed),
				() => ipcRenderer.send('studio:close-result', false),
			)
		}
		ipcRenderer.on('studio:before-close', request)
		ipcRenderer.send('studio:close-ready', true)
		return () => {
			ipcRenderer.removeListener('studio:before-close', request)
			ipcRenderer.send('studio:close-ready', false)
		}
	},
	connect: () => ipcRenderer.send('studio:connect'),
	openProject: () => ipcRenderer.invoke('studio:open-project'),
	revealInFileManager: (input) => ipcRenderer.invoke('studio:reveal-in-file-manager', input),
	saveArtifact: (input) => ipcRenderer.invoke('studio:save-artifact', input),
	saveFile: (input) => ipcRenderer.invoke('studio:save-file', input),
	importFile: (input) => ipcRenderer.invoke('studio:import-file', input),
}
// Transfer the actual port into the main world. RPC proxies never cross contextBridge.
ipcRenderer.on('studio:port', (event, data) => {
	window.postMessage(
		{ type: 'studio:port', replacement: data?.replacement === true },
		'*',
		event.ports,
	)
})
contextBridge.exposeInMainWorld('studio', bridge)
