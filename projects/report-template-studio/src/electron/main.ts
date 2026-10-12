import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	MessageChannelMain,
	net,
	protocol,
	shell,
	utilityProcess,
	type IpcMainInvokeEvent,
	type IpcMainEvent,
	type UtilityProcess,
} from 'electron'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pathName, safePath } from '../backend/storage-validation.ts'
import { createNativeDesktopClient } from '../rpc/message-port.ts'

protocol.registerSchemesAsPrivileged([
	{ scheme: 'studio', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
const development = !app.isPackaged && process.env.STUDIO_DEV === '1'
if (development && !process.env.STUDIO_PROJECT_ROOT)
	throw new Error('Missing Studio development root')
const applicationRoot = development
	? resolve(process.env.STUDIO_PROJECT_ROOT!)
	: resolve(import.meta.dirname, '../..')
function developmentRenderer() {
	const url = new URL(process.env.STUDIO_RENDERER_URL ?? '')
	if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
		throw new Error('Studio development renderer must use a loopback Vite URL')
	return url.origin
}
const rendererOrigin = development ? developmentRenderer() : 'studio://app'
const rendererUrl = development ? rendererOrigin + '/' : 'studio://app/index.html'
let restarting = false
function allowedRenderer(url: string) {
	try {
		const parsed = new URL(url)
		if (parsed.username || parsed.password) return false
		return development
			? parsed.origin === rendererOrigin
			: parsed.protocol === 'studio:' && parsed.host === 'app'
	} catch {
		return false
	}
}
const rendererRoot = join(applicationRoot, 'dist/renderer')
const MAX_BYTES = 128 * 1024 * 1024
let window: BrowserWindow | undefined
let backend: UtilityProcess | undefined
let closed = false
let nativeClient: ReturnType<typeof createNativeDesktopClient> | undefined

function sender(event: IpcMainInvokeEvent | IpcMainEvent) {
	if (
		!window ||
		event.sender !== window.webContents ||
		event.senderFrame !== window.webContents.mainFrame ||
		!allowedRenderer(event.senderFrame.url)
	)
		throw new Error('Unknown Studio sender')
}
function nativeApi() {
	if (!nativeClient || !backend || closed) throw new Error('Studio backend is unavailable')
	return nativeClient.api
}

async function startWindow() {
	await app.whenReady()
	protocol.handle('studio', async (request) => {
		const url = new URL(request.url)
		if (url.hostname !== 'app' || request.method !== 'GET')
			return new Response('Not found', { status: 404 })
		const path = resolve(
			rendererRoot,
			'.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
		)
		const rel = relative(rendererRoot, path)
		if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 })
		try {
			const result = await net.fetch(pathToFileURL(path).href)
			const headers = new Headers(result.headers)
			headers.set(
				'Content-Security-Policy',
				"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
			)
			return new Response(result.body, { status: result.status, headers })
		} catch {
			return new Response('Not found', { status: 404 })
		}
	})

	try {
		await new Promise<void>((accept, reject) => {
			backend = utilityProcess.fork(
				join(import.meta.dirname, 'backend.mjs'),
				[
					join(app.getPath('userData'), 'studio'),
					join(applicationRoot, 'financial-document-assets'),
				],
				{
					serviceName: 'Pluxel Typst Studio',
					env: {
						...process.env,
						STUDIO_DEV: development ? '1' : '0',
						STUDIO_PROJECT_ROOT: development ? applicationRoot : '',
					},
				},
			)
			backend.on('message', (message) => {
				if (message.type === 'ready') accept()
			})
			backend.once('exit', (code) => {
				const error = new Error(`Studio backend exited (${code})`)
				reject(error)
				nativeClient?.disconnect()
				nativeClient = undefined
				backend = undefined
			})
		})
		const nativeChannel = new MessageChannelMain()
		backend!.postMessage({ type: 'native-port' }, [nativeChannel.port2])
		nativeClient = createNativeDesktopClient(nativeChannel.port1)
		ipcMain.on('studio:connect', (event) => {
			try {
				sender(event)
				if (!backend || closed) return
				const channel = new MessageChannelMain()
				backend.postMessage({ type: 'desktop-port' }, [channel.port2])
				event.senderFrame!.postMessage('studio:port', null, [channel.port1])
			} catch (error) {
				console.error('Studio renderer connection rejected', error)
			}
		})
		ipcMain.handle(
			'studio:save-artifact',
			async (event, input: { artifactId: string; suggestedName: string }) => {
				sender(event)
				if (
					!input ||
					typeof input.artifactId !== 'string' ||
					typeof input.suggestedName !== 'string'
				)
					throw new Error('Invalid artifact export')
				// Resolve only an application-owned artifact id over the trusted utility port.
				const artifact = await nativeApi().resolveArtifact({ id: input.artifactId })
				const result = await dialog.showSaveDialog(window!, {
					defaultPath: basename(input.suggestedName),
				})
				if (result.canceled || !result.filePath) return false
				await copyFile(artifact.path, result.filePath)
				return true
			},
		)
		ipcMain.handle(
			'studio:save-file',
			async (event, input: { suggestedName: string; bytes: Uint8Array }) => {
				sender(event)
				if (
					!input ||
					typeof input.suggestedName !== 'string' ||
					!(input.bytes instanceof Uint8Array) ||
					input.bytes.byteLength > MAX_BYTES
				)
					throw new Error('Invalid file export')
				const result = await dialog.showSaveDialog(window!, {
					defaultPath: basename(input.suggestedName),
				})
				if (result.canceled || !result.filePath) return false
				await writeFile(result.filePath, input.bytes)
				return true
			},
		)
		ipcMain.handle('studio:open-project', async (event) => {
			sender(event)
			const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] })
			if (result.canceled || !result.filePaths[0]) return null
			return nativeApi().openProject({ root: result.filePaths[0] })
		})
		ipcMain.handle(
			'studio:reveal-in-file-manager',
			async (event, input: { projectId: string; path: string }) => {
				sender(event)
				if (
					!input ||
					typeof input.projectId !== 'string' ||
					!input.projectId ||
					typeof input.path !== 'string'
				)
					throw new Error('Invalid project file location')
				const workspacePath = input.path === '' ? '' : pathName(input.path)
				const project = await nativeApi().getProject({ projectId: input.projectId })
				if (typeof project.root !== 'string' || !isAbsolute(project.root))
					throw new Error('Invalid project root')
				const path = await safePath(
					workspacePath ? join(project.root, workspacePath) : project.root,
				)
				const file = await stat(path)
				if (!file.isFile() && !file.isDirectory()) throw new Error('Invalid project file')
				if (!workspacePath) {
					if (!file.isDirectory()) throw new Error('Project root is not a directory')
					const error = await shell.openPath(path)
					if (error) throw new Error(error)
				} else shell.showItemInFolder(path)
			},
		)
		ipcMain.handle('studio:import-file', async (event, input: { kind: 'asset' | 'workspace' }) => {
			sender(event)
			if (!input || !['asset', 'workspace'].includes(input.kind))
				throw new Error('Invalid import kind')
			const result = await dialog.showOpenDialog(window!, {
				properties: ['openFile'],
				filters: [
					{
						name: input.kind === 'asset' ? '项目资产' : 'Workspace ZIP',
						extensions: input.kind === 'asset' ? ['*'] : ['zip'],
					},
				],
			})
			if (result.canceled || !result.filePaths[0]) return null
			const file = result.filePaths[0]
			const fileStat = await stat(file)
			if (fileStat.size > MAX_BYTES) throw new Error('File exceeds 128 MiB')

			return { name: basename(file), bytes: new Uint8Array(await readFile(file)) }
		})
		window = new BrowserWindow({
			width: 1500,
			height: 960,
			minWidth: 1000,
			minHeight: 650,
			title: 'Typst Studio',
			backgroundColor: '#f7f8fa',
			webPreferences: {
				preload: join(import.meta.dirname, 'preload.cjs'),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
			},
		})
		if (development) {
			window.webContents.session.webRequest.onHeadersReceived(
				{ urls: [`${rendererOrigin}/*`] },
				(details, callback) =>
					callback({
						responseHeaders: {
							...details.responseHeaders,
							'Content-Security-Policy': [
								`default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${rendererOrigin.replace('http:', 'ws:')}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'`,
							],
						},
					}),
			)
			window.webContents.on('will-prevent-unload', () => {
				if (restarting) {
					restarting = false
					process.send?.({ type: 'studio:dev-stop-cancelled' })
				}
			})
		}
		window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
		window.webContents.on('will-navigate', (event, url) => {
			if (!allowedRenderer(url)) event.preventDefault()
		})
		await window.loadURL(rendererUrl)
	} catch (error) {
		console.error(error)
		dialog.showErrorBox('Studio 启动失败', error instanceof Error ? error.message : String(error))
		app.quit()
	}
}
if (app.requestSingleInstanceLock()) {
	app.on('second-instance', () => {
		if (window?.isMinimized()) window.restore()
		window?.focus()
	})
	void startWindow()
} else {
	if (development) console.info('[studio:dev] Studio 已在运行。请先关闭旧窗口，再启动 dev。')
	closed = true
	app.quit()
}

app.on('window-all-closed', () => app.quit())
app.on('will-quit', (event) => {
	if (closed) return
	event.preventDefault()
	closed = true
	void (async () => {
		try {
			if (backend) {
				const activeBackend = backend
				await new Promise<void>((accept, reject) => {
					const timeout = setTimeout(() => {
						settle(new Error('Studio backend close timed out'))
					}, 30_000)
					function settle(error?: Error) {
						clearTimeout(timeout)
						activeBackend.removeListener('message', finished)
						activeBackend.removeListener('exit', exited)
						if (error) reject(error)
						else accept()
					}
					function exited(code: number) {
						settle(new Error(`Studio backend exited while closing (${code})`))
					}
					function finished(message: { type?: string; error?: string }) {
						if (message.type !== 'closed') return
						settle(message.error ? new Error(message.error) : undefined)
					}
					activeBackend.on('message', finished)
					activeBackend.on('exit', exited)
					try {
						activeBackend.postMessage({ type: 'close' }, [])
					} catch (error) {
						settle(error instanceof Error ? error : new Error(String(error)))
					}
				})
			}
		} catch (error) {
			console.error('Studio shutdown failed', error)
		} finally {
			nativeClient?.disconnect()
			backend?.kill()
			app.quit()
		}
	})()
})

// The dev supervisor requests an ordinary quit. Unsaved renderer state can veto it;
// drain the backend only at will-quit, after all windows have actually closed.
if (development)
	process.on('message', (message: unknown) => {
		if (
			message &&
			typeof message === 'object' &&
			'type' in message &&
			message.type === 'studio:dev-stop'
		) {
			restarting = true
			app.quit()
		}
	})
