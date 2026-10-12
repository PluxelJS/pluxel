import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	net,
	protocol,
	shell,
	utilityProcess,
	type IpcMainInvokeEvent,
	type UtilityProcess,
} from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pathName, safePath } from '../backend/storage-validation.ts'
import type { FetchRequest, FetchResponse, ProjectSummary } from '../shared/contracts.ts'

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
	const parsed = new URL(url)
	return development
		? parsed.origin === rendererOrigin
		: parsed.protocol === 'studio:' && parsed.hostname === 'app'
}
const rendererRoot = join(applicationRoot, 'dist/renderer')
const MAX_BYTES = 128 * 1024 * 1024
let window: BrowserWindow | undefined
let backend: UtilityProcess | undefined
let sequence = 0
let closed = false
const pending = new Map<
	number,
	{ resolve(value: FetchResponse | undefined): void; reject(error: Error): void }
>()

function sender(event: IpcMainInvokeEvent) {
	if (
		!window ||
		event.sender !== window.webContents ||
		event.senderFrame !== window.webContents.mainFrame ||
		!allowedRenderer(event.senderFrame.url)
	)
		throw new Error('Unknown Studio sender')
}
function dispatchRequest(input: FetchRequest): Promise<FetchResponse> {
	if (
		!input ||
		typeof input.path !== 'string' ||
		!input.path.startsWith('/api/') ||
		input.path.includes('\\') ||
		input.path.includes('#') ||
		!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)
	)
		throw new Error('Invalid Studio request')
	const url = new URL(input.path, 'http://studio.local')
	if (url.origin !== 'http://studio.local' || !url.pathname.startsWith('/api/'))
		throw new Error('Invalid Studio route')
	if (input.body && (!(input.body instanceof Uint8Array) || input.body.byteLength > MAX_BYTES))
		throw new Error('Request exceeds 128 MiB')
	if (!backend || closed) throw new Error('Studio backend is unavailable')
	const id = ++sequence
	return new Promise((accept, reject) => {
		pending.set(id, {
			resolve: (value) => (value ? accept(value) : reject(new Error('Missing backend response'))),
			reject,
		})
		backend!.postMessage(
			{
				id,
				request: {
					path: url.pathname + url.search,
					method: input.method,
					body: input.body,
					headers: input.headers?.filter(([name]) => name.toLowerCase() === 'content-type'),
				},
			},
			[],
		)
	})
}
function failPending(error: Error) {
	for (const task of pending.values()) task.reject(error)
	pending.clear()
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
				if (message.ready) {
					accept()
					return
				}
				const task = pending.get(message.id)
				if (!task) return
				pending.delete(message.id)
				if (message.error) task.reject(new Error(message.error))
				else task.resolve(message.result)
			})
			backend.once('exit', (code) => {
				const error = new Error(`Studio backend exited (${code})`)
				reject(error)
				failPending(error)
				backend = undefined
			})
		})
		ipcMain.handle('studio:fetch', (event, input: FetchRequest) => {
			sender(event)
			return dispatchRequest(input)
		})
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
			const response = await dispatchRequest({
				path: '/api/projects/open',
				method: 'POST',
				headers: [['content-type', 'application/json']],
				body: new TextEncoder().encode(JSON.stringify({ root: result.filePaths[0] })),
			})
			const value = JSON.parse(new TextDecoder().decode(response.body))
			if (response.status >= 400) throw new Error(value.error ?? 'Cannot open project')
			return value
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
				const response = await dispatchRequest({
					path: `/api/projects/${encodeURIComponent(input.projectId)}`,
					method: 'GET',
				})
				const value = JSON.parse(new TextDecoder().decode(response.body))
				if (response.status >= 400) throw new Error(value.error ?? 'Cannot locate project')
				const project = value as ProjectSummary
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
				const id = ++sequence
				const draining = new Promise<void>((accept, reject) => {
					pending.set(id, { resolve: () => accept(), reject })
				})
				backend.postMessage({ id, close: true }, [])
				await draining
				backend.kill()
			}
		} catch (error) {
			console.error('Studio shutdown failed', error)
		} finally {
			failPending(new Error('Studio closed'))
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
