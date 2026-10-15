import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'vite-plus/pack'
import { createServer } from 'vite'
import { runPnpm } from './run-pnpm.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, '.studio-dev')
const forwarded = process.argv.slice(2).filter((arg) => arg !== '--')
const env = { ...process.env, STUDIO_DEV: '1', STUDIO_PROJECT_ROOT: root }
delete env.ELECTRON_RUN_AS_NODE
let server
let child
let stopping = false
let restarting = false
let pendingRestart = false
let timer

async function buildCarrier() {
	const result = await build({ cwd: root, config: join(root, 'tsdown.dev.config.ts') })
	await Promise.all(result.bundles.map((bundle) => bundle[Symbol.asyncDispose]()))
	const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
	// Keep Electron's application identity/userData identical to `electron .`.
	await writeFile(
		join(output, 'package.json'),
		JSON.stringify({
			name: manifest.name,
			type: 'module',
			main: 'electron/main.mjs',
		}),
	)
}

function launch() {
	const process = spawn(electron, [output, ...forwarded], {
		cwd: root,
		env,
		stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
	})
	child = process
	process.once('error', (error) => {
		console.error('[studio:dev] Electron failed to start:', error)
		void shutdown(1)
	})
	process.once('exit', (code) => {
		if (child === process) child = undefined
		if (!restarting && !stopping) void shutdown(code ?? 1)
	})
}

async function closeElectron() {
	const current = child
	if (!current || current.exitCode !== null || current.signalCode !== null) return true
	return new Promise((accept) => {
		const finish = (closed) => {
			current.off('exit', onExit)
			current.off('message', onMessage)
			accept(closed)
		}
		const onExit = () => finish(true)
		const onMessage = (message) => {
			if (message?.type === 'studio:dev-stop-cancelled') finish(false)
		}
		current.once('exit', onExit)
		current.on('message', onMessage)
		if (current.connected) {
			current.send({ type: 'studio:dev-stop' }, (error) => {
				if (error && current.exitCode === null) {
					console.error('[studio:dev] Cannot request shutdown:', error)
					finish(false)
				}
			})
		} else finish(false)
	})
}

async function restart() {
	if (stopping || restarting) return
	restarting = true
	try {
		while (pendingRestart && !stopping) {
			pendingRestart = false
			console.info('[studio:dev] Electron source changed; restarting after graceful shutdown…')
			if (!(await closeElectron())) {
				console.info(
					'[studio:dev] Restart cancelled. Save your edits; the next carrier change will retry.',
				)
				pendingRestart = false
				break
			}
			await buildCarrier()
			if (!stopping) launch()
		}
	} catch (error) {
		console.error('[studio:dev] Build failed; fix the source to retry:', error)
	} finally {
		restarting = false
	}
}

async function shutdown(code = 0) {
	if (stopping) return
	stopping = true
	clearTimeout(timer)
	if (!(await closeElectron())) {
		stopping = false
		console.info('[studio:dev] Shutdown cancelled; the development session is still running.')
		return
	}
	await server?.close()
	process.exitCode = code
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

function scheduleRestart() {
	if (stopping) return
	pendingRestart = true
	clearTimeout(timer)
	timer = setTimeout(() => void restart(), 150)
}

async function start() {
	runPnpm(['--filter', '@pluxel/typst', 'prepare:native'], { cwd: root, stdio: 'inherit' })
	await buildCarrier()
	if (stopping) return
	server = await createServer({
		root,
		configFile: join(root, 'vite.config.ts'),
		clearScreen: false,
		server: { host: '127.0.0.1', port: 0, open: false },
		plugins: [
			{
				name: 'studio-electron-carrier',
				configureServer(vite) {
					// configureServer runs again when Vite reloads its own config.
					vite.watcher.on('all', (_event, file) => {
						const path = relative(root, file).replaceAll('\\', '/')
						if (
							path.startsWith('src/electron/') ||
							path === 'src/backend/dev.ts' ||
							path === 'tsdown.dev.config.ts'
						)
							scheduleRestart()
					})
					vite.httpServer.on('listening', () => {
						const address = vite.httpServer.address()
						if (!address || typeof address === 'string') return
						const origin = `http://127.0.0.1:${address.port}`
						const changed = env.STUDIO_RENDERER_URL && env.STUDIO_RENDERER_URL !== origin
						env.STUDIO_RENDERER_URL = origin
						if (changed && child) scheduleRestart()
					})
				},
			},
		],
	})
	if (stopping) {
		await server.close()
		return
	}
	await server.listen()
	if (stopping) {
		await server.close()
		return
	}
	if (!env.STUDIO_RENDERER_URL) throw new Error('Missing renderer server address')
	console.info(`[studio:dev] Renderer: ${env.STUDIO_RENDERER_URL} (React Fast Refresh)`)
	console.info(
		'[studio:dev] Business calls use Cap’n Web MessagePort/local IPC; backend HMR uses host-vite.',
	)
	launch()
}

try {
	await start()
} catch (error) {
	console.error('[studio:dev]', error)
	await shutdown(1)
}
