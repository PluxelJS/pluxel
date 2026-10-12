import { contextBridge, ipcRenderer } from 'electron'
import type { StudioBridge } from '../shared/contracts.ts'

const bridge: StudioBridge = {
	openProject: () => ipcRenderer.invoke('studio:open-project'),
	revealInFileManager: (input) => ipcRenderer.invoke('studio:reveal-in-file-manager', input),
	fetch: (request) => ipcRenderer.invoke('studio:fetch', request),
	saveFile: (input) => ipcRenderer.invoke('studio:save-file', input),
	importFile: (input) => ipcRenderer.invoke('studio:import-file', input),
}
contextBridge.exposeInMainWorld('studio', bridge)
