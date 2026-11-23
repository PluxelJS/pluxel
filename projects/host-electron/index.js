import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { createScriptScope } from '@pluxel/agent-sdk/host'
import { startHost } from '@pluxel/host'
import {
	defineHostApplication,
	defineHostService,
	installOwnerViewService,
} from '@pluxel/host/application'
import {
	inspectHost,
	probeEnvironment,
	probePlugins,
} from '@pluxel-example/host-targets-plugins/probe'
import { DesktopApp, DesktopInfo } from '@pluxel-example/host-electron'

const sourceUrl = 'https://electron.example.test/greeting'
const expectedSource = 'Electron main process'
const application = defineHostApplication(() => ({
	coreConfig: {
		logtape: {},
		vault: { backend: 'bindings' },
		http: {
			allowedOrigins: [new URL(sourceUrl).origin],
			fetch: async () => Response.json({ source: expectedSource }),
		},
	},
	plugins: [...probePlugins(sourceUrl), { plugin: DesktopInfo, autoStart: true }],
	services: [
		defineHostService({
			name: 'DesktopApp',
			provides: [
				installOwnerViewService(DesktopApp, {
					createRoot: () => app,
					createView: (desktop) => ({
						getName: () => desktop.getName(),
						getVersion: () => desktop.getVersion(),
					}),
				}),
			],
		}),
	],
}))

const closed = Promise.withResolvers()
/** @param {Electron.Event} event */
function beforeQuit(event) {
	event.preventDefault()
	closed.resolve(undefined)
}

async function run() {
	await using host = await startHost(application, { env: probeEnvironment })
	await using scope = createScriptScope({ ctx: host.ctx })
	const shared = await inspectHost(scope.sdk, { sourceUrl, expectedSource })
	const { instance } = await scope.sdk.plugin(DesktopInfo.nodeAddress()).instance()
	const desktop = instance.inspect()
	if (desktop.name !== app.getName() || desktop.version !== app.getVersion())
		throw new Error('DesktopInfo did not return the native application name and version')
	const receipt = { electron: process.versions.electron, desktop, shared }
	const window = new BrowserWindow({ width: 760, height: 680, autoHideMenuBar: true })
	try {
		window.once('closed', () => closed.resolve(undefined))
		await window.loadFile(fileURLToPath(new URL('receipt.html', import.meta.url)), {
			hash: encodeURIComponent(JSON.stringify(receipt)),
		})
		if (process.argv.includes('--smoke')) {
			const visible = await window.webContents.executeJavaScript(
				"document.getElementById('receipt').textContent",
			)
			if (visible !== JSON.stringify(receipt, null, 2))
				throw new Error('Window receipt differs from the main process')
			console.log(JSON.stringify(receipt))
		} else {
			await closed.promise
		}
	} finally {
		if (!window.isDestroyed()) window.destroy()
	}
}

app.on('before-quit', beforeQuit)
app
	.whenReady()
	.then(run)
	.then(
		() => {
			app.off('before-quit', beforeQuit)
			return app.quit()
		},
		(error) => {
			console.error(error)
			app.exit(1)
		},
	)
