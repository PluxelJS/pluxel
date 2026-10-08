import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createServer } from 'vite'
import { host, hostSingletons, closeHostViteSession } from '@pluxel/host-vite'
import { connectNative } from './src/execution/node.ts'

const root = import.meta.dirname
const args = process.argv.slice(2)
if (args.length > 0 && (args.length !== 2 || args[0] !== '--profile'))
	throw new Error('Usage: node dev.mjs [--profile ABSOLUTE_DIRECTORY]')
const profile = resolve(args[1] ?? resolve(root, '.pluxel/dev'))
let child
let server
let connection
let closing
async function close() {
	if (closing) return closing
	closing = (async () => {
		const errors = []
		if (server) {
			try {
				await closeHostViteSession(server)
			} catch (error) {
				errors.push(error)
			}
			try {
				await server.close()
			} catch (error) {
				errors.push(error)
			}
		}
		try {
			await connection?.close()
		} catch (error) {
			errors.push(error)
		}
		// Disconnecting development leaves the native application's window/profile alive.
		child?.unref()
		child?.stdout?.destroy()
		if (errors.length > 0) throw new AggregateError(errors, 'Development shutdown failed')
	})()
	return closing
}
const onSignal = () => {
	void close().then(
		() => {
			process.exitCode = 0
			return undefined
		},
		(error) => {
			console.error(error)
			process.exitCode = 1
			return undefined
		},
	)
}
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
try {
	let endpoint
	try {
		endpoint = JSON.parse(await readFile(resolve(profile, 'endpoint.json'), 'utf8'))
		if (!Number.isSafeInteger(endpoint.pid) || endpoint.pid <= 0)
			throw new Error('Native endpoint has an invalid process identity')
		try {
			process.kill(endpoint.pid, 0)
		} catch (error) {
			if (error.code !== 'ESRCH') throw error
			endpoint = undefined
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
	if (!endpoint) {
		child = spawn(
			'cargo',
			[
				'run',
				'--locked',
				'--manifest-path',
				resolve(root, 'native/Cargo.toml'),
				'--bin',
				'embedded-launcher',
				'--',
				'--dev',
				'--profile',
				profile,
			],
			{
				cwd: root,
				detached: true,
				stdio: ['ignore', 'pipe', 'inherit'],
			},
		)
		endpoint = await new Promise((accept, reject) => {
			const lines = createInterface({ input: child.stdout })
			child.once('error', reject)
			child.once('exit', (code, signal) =>
				reject(new Error(`Native application exited before ready (${code ?? signal})`)),
			)
			lines.on('line', (line) => {
				try {
					const value = JSON.parse(line)
					if (value.event === 'ready') {
						lines.close()
						accept(value)
					}
				} catch {
					console.error(`[native] ${line}`)
				}
			})
		})
	}
	connection = await connectNative(endpoint)
	server = await createServer({
		root,
		configFile: false,
		appType: 'custom',
		server: { middlewareMode: true },
		plugins: [
			hostSingletons({
				packages: ['@embedded-launcher/sdk', '@pluxel/services', '@pluxel/commands'],
			}),
			host({
				entry: './src/app.ts',
				devConsole: true,
				bindings: {
					transport: connection.transport,
					configStorage: connection.documentStorage('config'),
					stateStorage: connection.documentStorage('state'),
					attachHost: connection.attachHost,
				},
			}),
		],
	})
	console.log(
		JSON.stringify({
			event: 'development-ready',
			root,
			profile,
			session: connection.session,
			pid: process.pid,
		}),
	)
	child?.once('exit', () => {
		void close().catch((error) => {
			console.error(error)
			process.exitCode = 1
		})
	})
} catch (error) {
	await close().catch((cleanup) => console.error(cleanup))
	throw error
}
