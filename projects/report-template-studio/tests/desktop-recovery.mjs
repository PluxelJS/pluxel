import assert from 'node:assert/strict'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'vite-plus/pack'
import { createServer } from 'vite'
import { _electron as electron } from 'playwright'
import electronExecutable from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform === 'win32')
	throw new Error('This recovery check requires the Linux/macOS dev console')
const directory = await mkdtemp(join(tmpdir(), 'studio-desktop-recovery-'))
const appRoot = join(directory, 'app')
const output = join(root, 'test-results/desktop-recovery')
const execute = promisify(execFile)
const logs = []
let server, application, processClosed, page, evidence
async function until(check, message) {
	const deadline = Date.now() + 60_000
	while (Date.now() < deadline) {
		if (await check()) return
		await new Promise((done) => setTimeout(done, 100))
	}
	throw new Error(message)
}
// Use the installed workspace CLI; pin the discovered root and instance for every run.
async function command(args) {
	const { stdout } = await execute(
		process.execPath,
		[fileURLToPath(import.meta.resolve('vite-plus/bin')), 'exec', 'pluxel', 'dev', ...args],
		{ cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 },
	)
	return JSON.parse(stdout)
}
let instanceId
async function inspect(action = 'inspect') {
	const result = await command([
		'run',
		join(appRoot, 'dev/check.ts'),
		'--root',
		appRoot,
		'--instance',
		instanceId,
		'--input',
		JSON.stringify({ action }),
	])
	assert.equal(result.ok, true)
	assert.equal(result.value.state, 'succeeded')
	return result.value.value
}
try {
	await mkdir(output, { recursive: true })
	await mkdir(appRoot)
	await cp(join(root, 'src'), join(appRoot, 'src'), { recursive: true })
	const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
	// This fixture starts its own processes and discovers the standalone Vite root directly.
	delete manifest.pluxel?.dev
	await writeFile(join(appRoot, 'package.json'), JSON.stringify(manifest))
	for (const name of ['node_modules', 'dist', 'financial-document-assets', 'workspace-assets'])
		await symlink(
			join(root, name),
			join(appRoot, name),
			process.platform === 'win32' ? 'junction' : 'dir',
		)
	await mkdir(join(appRoot, 'dev'))
	await writeFile(
		join(appRoot, 'dev/check.ts'),
		`
import { defineDevConsole } from '@pluxel/host-vite/console'
import { StudioPlugin } from '../src/backend/plugin.ts'
export default defineDevConsole(async dev => {
  const api = dev.plugins.require(StudioPlugin)
  const project = (await api.listProjects()).find(item => item.name === 'Recovery test')
  if (!project) return { projects: await api.listProjects() }
  const tree = await api.getTree({ projectId: project.id })
  const document = tree.documents.find(item => item.name === '银行询证函')!
  const target = { projectId: project.id, entry: document.entry }
  if ((dev.input as { action: string }).action === 'prepare') {
    const file = await api.readFile({ projectId: project.id, path: document.entry })
    await api.writeFile({projectId: project.id, path: file.path, expectedVersion: file.version,
      content: file.content.replace('schema: v.object({', 'schema: v.object({\\n  reviewRows: v.optional(v.pipe(v.array(v.object({ label: v.string() })), v.title("审核可选明细"))),')})
  }
  return { input: await api.getInput(target), plugins: await dev.plugins.list(), update: await dev.updates.latest() }
})
`,
	)
	const built = await build({ cwd: root, config: join(root, 'tsdown.dev.config.ts') })
	await Promise.all(built.bundles.map((bundle) => bundle[Symbol.asyncDispose]()))
	server = await createServer({
		root,
		configFile: join(root, 'vite.config.ts'),
		server: { host: '127.0.0.1', port: 0 },
	})
	await server.listen()
	const address = server.httpServer.address()
	const env = {
		...process.env,
		STUDIO_DEV: '1',
		STUDIO_PROJECT_ROOT: appRoot,
		STUDIO_RENDERER_URL: `http://127.0.0.1:${address.port}`,
	}
	delete env.ELECTRON_RUN_AS_NODE
	application = await electron.launch({
		executablePath: electronExecutable,
		args: [
			join(root, '.studio-dev/electron/main.mjs'),
			`--user-data-dir=${join(directory, 'profile')}`,
			'--disable-gpu',
			...(process.platform === 'linux' && process.env.WAYLAND_DISPLAY
				? ['--ozone-platform=wayland']
				: []),
			...(process.env.STUDIO_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []),
		],
		env,
		timeout: 90_000,
	})
	processClosed = once(application.process(), 'close')
	application.process().stderr?.on('data', (bytes) => logs.push(bytes.toString()))
	application.process().stdout?.on('data', (bytes) => logs.push(bytes.toString()))
	page = await application.firstWindow({ timeout: 90_000 })
	page.setDefaultTimeout(60_000)
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('Recovery test')
	await page.getByRole('button', { name: '新建项目', exact: true }).click()
	await page.locator('.typst-pages:visible svg').first().waitFor()
	const discovered = await command(['instances', '--root', appRoot])
	assert.equal(discovered.ok, true)
	assert.equal(discovered.value.length, 1)
	instanceId = discovered.value[0].instanceId
	await inspect('prepare')
	await page
		.getByRole('treeitem')
		.and(page.locator('[data-path="报表/银行询证函/银行询证函.ts"]'))
		.click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('表单', { exact: true })
		.click()
	await page.getByText('审核可选明细', { exact: true }).waitFor()
	const bank = page.getByRole('textbox', { name: '银行名称', exact: false })
	await bank.fill('Optional table preserved')
	await until(async () => {
		const state = await inspect()
		return (
			state.input.data.header?.bankName === 'Optional table preserved' &&
			!Object.hasOwn(state.input.data, 'reviewRows')
		)
	}, 'Optional table prevented input persistence')
	await page.evaluate(() => {
		window.recoveryProbe = { replacements: 0, identity: crypto.randomUUID() }
		window.addEventListener('message', (event) => {
			if (event.source === window && event.data?.type === 'studio:port' && event.data.replacement)
				window.recoveryProbe.replacements++
		})
	})
	const identity = await page.evaluate(() => window.recoveryProbe.identity)
	const entry = join(appRoot, 'src/backend/application.ts')
	const source = await readFile(entry, 'utf8')
	for (let generation = 1; generation <= 2; generation++) {
		await writeFile(
			entry,
			source.replace("name: 'report-template-studio'", `name: 'studio-recovery-${generation}'`),
		)
		await until(
			() => page.evaluate((expected) => window.recoveryProbe.replacements === expected, generation),
			'Desktop did not receive replacement port',
		)
		await until(
			() => page.getByRole('button', { name: '导出 PDF', exact: true }).isEnabled(),
			'Preview revision did not recover',
		)
		assert.equal(
			await page.evaluate(() => window.recoveryProbe.identity),
			identity,
			'HMR must preserve the mounted page',
		)
		assert.equal(
			await bank.inputValue(),
			generation === 1 ? 'Optional table preserved' : 'After generation 1',
		)
		await bank.fill(`After generation ${generation}`)
		await until(async () => {
			const snapshot = await inspect()
			return snapshot.input.data.header?.bankName === `After generation ${generation}`
		}, 'Editing after HMR failed')
		await until(
			() => page.getByRole('button', { name: '导出 PDF', exact: true }).isEnabled(),
			'Edited preview did not recover',
		)
		const pdf = join(output, `generation-${generation}.pdf`)
		await rm(pdf, { force: true })
		await application.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath })
		}, pdf)
		await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
		await until(async () => {
			try {
				const contents = await readFile(pdf)
				return contents.subarray(0, 5).toString() === '%PDF-'
			} catch (error) {
				if (error.code !== 'ENOENT') throw error
				return false
			}
		}, 'Native main-process artifact save did not recover')
	}
	await page.screenshot({ path: join(output, 'recovered.png') })
	assert.deepEqual(errors, [])
	evidence = {
		generations: 2,
		samePage: true,
		optionalTableOmitted: true,
		nativePdfSaves: 2,
		console: await inspect(),
	}
} catch (error) {
	await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
	throw error
} finally {
	try {
		if (application) {
			await application
				.evaluate(({ BrowserWindow }) => {
					for (const window of BrowserWindow.getAllWindows()) window.destroy()
				})
				.catch((error) => {
					if (!error.message.includes('Target page, context or browser has been closed'))
						throw error
				})
			await application.close()
			const [code, signal] = await processClosed
			assert.equal(code, 0, 'The Electron process exits after backend cleanup')
			assert.equal(signal, null)
			assert.doesNotMatch(logs.join(''), /Studio shutdown failed/)
		}
	} finally {
		await server?.close()
		await writeFile(join(output, 'electron.log'), logs.join(''))
		await rm(directory, { recursive: true, force: true })
	}
}
await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2))
console.log(
	'Desktop recovery passed: two backend generations, form input, preview and native PDF save',
)
