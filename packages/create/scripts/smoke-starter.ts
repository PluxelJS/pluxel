import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pluxel-create-smoke-'))
const tarballRoot = resolve(temporaryRoot, 'tarballs')
const installRoot = resolve(temporaryRoot, 'create-install')
const generatedRoot = resolve(temporaryRoot, 'starter')
const publishRoots = [
	'@pluxel/cli',
	'@pluxel/core',
	'@pluxel/create',
	'@pluxel/rolldown',
	'@pluxel/runtime',
	'@pluxel/runtime-dynamic',
	'@pluxel/runtime-static',
	'@pluxel/test',
] as const

try {
	await mkdir(tarballRoot, { recursive: true })
	const publishPackages = await resolveLocalPublishClosure(repositoryRoot, publishRoots)
	await runPnpm(
		['exec', 'turbo', 'run', 'build', ...publishPackages.map(({ name }) => `--filter=${name}`)],
		repositoryRoot,
	)

	const overrides: Record<string, string> = {}
	for (const item of publishPackages) {
		const tarball = resolve(tarballRoot, `${item.name.replaceAll(/[@/]/g, '-')}.tgz`)
		await runPnpmCapture(['--dir', resolve(repositoryRoot, item.path), 'pack', '--out', tarball])
		overrides[item.name] = `file:${tarball}`
	}

	const createTarball = overrides['@pluxel/create']
	if (!createTarball) throw new Error('Local publish closure did not include @pluxel/create')
	await installPackedCreate(installRoot, createTarball)
	const createBin = resolve(
		installRoot,
		'node_modules/.bin',
		process.platform === 'win32' ? 'create-pluxel.cmd' : 'create-pluxel',
	)
	await runProcess(createBin, [generatedRoot, '--no-install'], installRoot)
	await assertGeneratedGitIgnore(generatedRoot)
	await verifyDocumentationLink(generatedRoot)
	await appendOverrides(resolve(generatedRoot, 'pnpm-workspace.yaml'), overrides)

	await runPnpm(['install', '--frozen-lockfile=false'], generatedRoot)
	await runPnpm(['verify'], generatedRoot, { CI: '1' })
	await verifyFrozenApplicationDistribution(generatedRoot)
	await verifyStaticViteApplication(generatedRoot)
	await verifyDynamicViteHost(generatedRoot)
} finally {
	if (process.env.PLUXEL_KEEP_TEMPLATE_SMOKE) {
		console.info(`Create smoke workspace kept at ${temporaryRoot}`)
	} else {
		await rm(temporaryRoot, { recursive: true, force: true })
	}
}

type LocalPublishPackage = {
	name: string
	path: string
	manifest: {
		dependencies?: Record<string, string>
		optionalDependencies?: Record<string, string>
		peerDependencies?: Record<string, string>
		peerDependenciesMeta?: Record<string, { optional?: boolean }>
	}
}

async function resolveLocalPublishClosure(
	root: string,
	rootNames: readonly string[],
): Promise<LocalPublishPackage[]> {
	const entries = await readdir(resolve(root, 'packages'), { withFileTypes: true })
	const discovered = new Map<string, LocalPublishPackage>()
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const path = `packages/${entry.name}`
		let manifest: LocalPublishPackage['manifest'] & { name?: string; private?: boolean }
		try {
			manifest = JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8'))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			throw error
		}
		if (manifest.private === true || !manifest.name) continue
		discovered.set(manifest.name, { name: manifest.name, path, manifest })
	}

	const closure = new Map<string, LocalPublishPackage>()
	const pending = [...rootNames]
	while (pending.length > 0) {
		const name = pending.shift()!
		if (closure.has(name)) continue
		const item = discovered.get(name)
		if (!item) throw new Error(`Local publish package not found: ${name}`)
		closure.set(name, item)
		for (const dependency of Object.keys({
			...item.manifest.dependencies,
			...item.manifest.optionalDependencies,
		})) {
			if (discovered.has(dependency)) pending.push(dependency)
		}
		for (const dependency of Object.keys(item.manifest.peerDependencies ?? {})) {
			if (
				discovered.has(dependency) &&
				item.manifest.peerDependenciesMeta?.[dependency]?.optional !== true
			) {
				pending.push(dependency)
			}
		}
	}
	return [...closure.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function installPackedCreate(root: string, tarball: string): Promise<void> {
	await mkdir(root, { recursive: true })
	await writeFile(
		resolve(root, 'package.json'),
		`${JSON.stringify({ name: 'create-pluxel-smoke', private: true, dependencies: { '@pluxel/create': tarball } }, null, 2)}\n`,
	)
	await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
	await runPnpm(['install', '--frozen-lockfile=false'], root)
}

async function appendOverrides(path: string, overrides: Record<string, string>): Promise<void> {
	const source = await readFile(path, 'utf8')
	const lines = Object.entries(overrides)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, specifier]) => `  '${name}': '${specifier}'`)
	const block = `${lines.join('\n')}\n`
	const marker = 'overrides:\n'
	await writeFile(
		path,
		source.includes(marker)
			? source.replace(marker, `${marker}${block}`)
			: `${source.trimEnd()}\n\n${marker}${block}`,
	)
}

async function assertGeneratedGitIgnore(root: string): Promise<void> {
	const contents = await readFile(resolve(root, '.gitignore'), 'utf8')
	if (!contents.includes('node_modules/') || !contents.includes('.pluxel/')) {
		throw new Error('Generated .gitignore is incomplete')
	}
}

async function verifyDocumentationLink(generated: string): Promise<void> {
	const readme = await readFile(resolve(generated, 'README.md'), 'utf8')
	if (!readme.includes('https://github.com/PluxelJS/pluxel/blob/main/docs/index.md')) {
		throw new Error('Created README does not link to canonical upstream documentation')
	}
	try {
		await readFile(resolve(generated, 'docs/pluxel/index.md'))
		throw new Error('Created workspace must not copy Pluxel documentation')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}

async function verifyFrozenApplicationDistribution(root: string): Promise<void> {
	const dist = resolve(root, 'host/dist')
	await runPnpm(['exec', 'pluxel', 'distribution', 'inspect', dist], root)
	const deployment = JSON.parse(
		await readFile(resolve(dist, 'pluxel-deployment.json'), 'utf8'),
	) as {
		kind?: string
		capabilities?: { workbench?: { included?: boolean } }
	}
	if (
		deployment.kind !== 'pluxel-static-application' ||
		deployment.capabilities?.workbench?.included !== true
	) {
		throw new Error('Created application deployment manifest is incomplete')
	}
	await Promise.all([
		readFile(resolve(dist, 'workbench/public/.vite/manifest.json')),
		readFile(resolve(dist, 'public/index.html')),
	])
	const environmentExample = await readFile(resolve(dist, '.env.example'), 'utf8')
	if (
		!environmentExample.includes('# EXAMPLE_TODO_MAX_ITEMS=') ||
		!environmentExample.includes('# Input: number')
	) {
		throw new Error(`Created application .env.example is incomplete: ${environmentExample}`)
	}

	const entry = pathToFileURL(resolve(dist, 'app.mjs')).href
	const smoke = [
		'const app = await import(process.argv[1])',
		'try {',
		"\tif (app.ctx.workbench === undefined) throw new Error('Workbench should be enabled by default')",
		'\tconst origin = `http://${app.address.host}:${app.address.port}`',
		'\tconst initial = await fetch(`${origin}/api/example/todos`)',
		"\tif (!initial.ok || (await initial.json()).items[0]?.title !== 'Trace a Todo from React to a Plugin') throw new Error(`Frozen Todo route returned ${initial.status}`)",
		"\tconst created = await fetch(`${origin}/api/example/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Smoke the frozen route' }) })",
		'\tif (created.status !== 201 || (await created.json()).items.length !== 2) throw new Error(`Frozen Todo mutation returned ${created.status}`)',
		"\tconst page = await fetch(`${origin}/nested/page`, { headers: { accept: 'text/html' } })",
		'\tif (!page.ok || !(await page.text()).includes(\'<div id="root"></div>\')) throw new Error(`Frozen SPA fallback returned ${page.status}`)',
		"\tconst workbench = await app.fetch(new Request(`${origin}/__pluxel/workbench/plugins`, { headers: { accept: 'text/html' } }))",
		'\tconst workbenchHtml = await workbench.text()',
		'\tif (!workbench.ok || !workbenchHtml.includes(\'content="/__pluxel/workbench"\')) throw new Error(`Frozen Workbench navigation returned ${workbench.status}: ${workbenchHtml.slice(0, 240)}`)',
		'\tconst shellEntry = workbenchHtml.match(/<script type="module" src="([^"]+)"/)?.[1]',
		"\tif (!shellEntry?.startsWith('/__pluxel/workbench/assets/')) throw new Error(`Frozen Workbench asset escaped the reserved namespace: ${shellEntry}`)",
		'\tconst shellAsset = await fetch(new URL(shellEntry, origin))',
		'\tif (!shellAsset.ok) throw new Error(`Frozen Workbench asset returned ${shellAsset.status}`)',
		'} finally {',
		'\tawait app.stop()',
		'}',
	].join('\n')
	await runProcess(process.execPath, ['--input-type=module', '--eval', smoke, entry], root, {
		PLUXEL_HOST_PORT: '0',
	})
}

async function verifyStaticViteApplication(root: string): Promise<void> {
	const port = await reservePort()
	const vite = startVite(root, '@example/host', 'vite.config.ts', port)
	try {
		const initial = await Promise.race([
			waitForResponse(`http://127.0.0.1:${port}/api/example/todos`, 30_000),
			vite.exit.then(({ code, signal }) => {
				throw new Error(`Static Vite host exited before it was ready (${signal ?? code})`)
			}),
		])
		const initialSnapshot = (await initial.json()) as {
			items?: Array<{ title?: string }>
			auditEnabled?: boolean
		}
		if (
			initialSnapshot.items?.[0]?.title !== 'Trace a Todo from React to a Plugin' ||
			initialSnapshot.auditEnabled !== true
		) {
			throw new Error('Static Vite host returned an unexpected Todo snapshot')
		}

		const created = await fetch(`http://127.0.0.1:${port}/api/example/todos`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'One origin serves both sides' }),
		})
		const createdSnapshot = (await created.json()) as { items?: unknown[] }
		if (created.status !== 201 || createdSnapshot.items?.length !== 2) {
			throw new Error(`Static Vite Todo mutation returned ${created.status}`)
		}

		await verifyViteBrowserGraph(`http://127.0.0.1:${port}`)
		const page = await fetch(`http://127.0.0.1:${port}/nested/page`, {
			headers: { accept: 'text/html' },
		})
		const pageSource = await page.text()
		if (!page.ok || !pageSource.includes('<div id="root"></div>')) {
			throw new Error(`Unified Vite page returned ${page.status}`)
		}
		await verifyWorkbenchNavigation(`http://127.0.0.1:${port}`)
	} finally {
		await stopVite(vite)
	}
}

async function verifyDynamicViteHost(root: string): Promise<void> {
	const port = await reservePort()
	const vite = startVite(root, '@example/host', 'vite.config.ts', port, {}, 'dynamic')
	try {
		const response = await Promise.race([
			waitForResponse(`http://127.0.0.1:${port}/api/example/todos`, 30_000),
			vite.exit.then(({ code, signal }) => {
				throw new Error(`Dynamic Vite host exited before it was ready (${signal ?? code})`)
			}),
		])
		const snapshot = (await response.json()) as { items?: Array<{ title?: string }> }
		if (!response.ok || snapshot.items?.[0]?.title !== 'Trace a Todo from React to a Plugin') {
			throw new Error(`Dynamic Todo route returned ${response.status}`)
		}
		await verifyViteBrowserGraph(`http://127.0.0.1:${port}`)
		const page = await fetch(`http://127.0.0.1:${port}/nested/page`, {
			headers: { accept: 'text/html' },
		})
		const pageSource = await page.text()
		if (!page.ok || !pageSource.includes('<div id="root"></div>')) {
			throw new Error(`Dynamic unified Vite page returned ${page.status}`)
		}
		await verifyWorkbenchNavigation(`http://127.0.0.1:${port}`)
	} finally {
		await stopVite(vite)
	}
}

async function verifyViteBrowserGraph(origin: string): Promise<void> {
	const refreshRuntime = await waitForResponse(`${origin}/@react-refresh`, 30_000)
	if (!refreshRuntime.headers.get('content-type')?.includes('javascript')) {
		throw new Error('Vite React refresh runtime is not served as JavaScript')
	}
	const entry = await waitForResponse(`${origin}/src/client/main.tsx`, 30_000)
	const source = await entry.text()
	const imports = [...source.matchAll(/\b(?:from|import)\s+["'](\/[^"']+)["']/g)].map(
		(match) => match[1]!,
	)
	if (imports.length < 2) throw new Error('Vite browser entry did not expose its React imports')
	await Promise.all(
		imports.map((specifier) => waitForResponse(new URL(specifier, origin).href, 30_000)),
	)
}

async function verifyWorkbenchNavigation(origin: string): Promise<void> {
	const response = await waitForDocumentResponse(`${origin}/__pluxel/workbench/plugins`, 30_000)
	const source = response.text
	if (!source.includes('content="/__pluxel/workbench"')) {
		throw new Error('Workbench navigation did not preserve its configured router base path')
	}
	const entry = source.match(/<script type="module" src="([^"]+)"/)?.[1]
	if (!entry) throw new Error('Workbench navigation did not expose a browser entry')
	const browserEntry = await waitForResponse(new URL(entry, origin).href, 30_000)
	if (!browserEntry.headers.get('content-type')?.includes('javascript')) {
		throw new Error(`Workbench browser entry is not JavaScript: ${entry}`)
	}
}

async function waitForDocumentResponse(
	url: string,
	timeoutMs: number,
): Promise<{ status: number; text: string }> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const response = await requestDocument(url)
			if (response.status >= 200 && response.status < 300) return response
			lastError = new Error(`HTTP ${response.status}`)
		} catch (error) {
			lastError = error
		}
		await new Promise((accept) => setTimeout(accept, 250))
	}
	throw new Error(`Timed out waiting for document ${url}: ${String(lastError)}`)
}

function requestDocument(url: string): Promise<{ status: number; text: string }> {
	return new Promise((resolveResponse, reject) => {
		const request = httpRequest(
			url,
			{
				headers: {
					accept: 'text/html',
					'sec-fetch-dest': 'document',
					'sec-fetch-mode': 'navigate',
				},
			},
			(response) => {
				const chunks: Buffer[] = []
				response.on('data', (chunk: Buffer) => chunks.push(chunk))
				response.once('error', reject)
				response.once('end', () => {
					resolveResponse({
						status: response.statusCode ?? 0,
						text: Buffer.concat(chunks).toString('utf8'),
					})
				})
			},
		)
		request.once('error', reject)
		request.end()
	})
}

function startVite(
	root: string,
	packageName: string,
	config: string,
	port: number,
	environment: Record<string, string> = {},
	mode?: string,
) {
	const command = process.env.npm_execpath ?? 'pnpm'
	const modeArgs = mode ? ['--mode', mode] : []
	const child = spawn(
		command,
		[
			'--filter',
			packageName,
			'exec',
			'vite',
			'--config',
			config,
			...modeArgs,
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--strictPort',
		],
		{ cwd: root, stdio: 'inherit', env: { ...process.env, ...environment } },
	)
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(accept, reject) => {
			child.once('error', reject)
			child.once('exit', (code, signal) => accept({ code, signal }))
		},
	)
	return { child, exit }
}

async function stopVite(vite: ReturnType<typeof startVite> | undefined): Promise<void> {
	if (!vite) return
	if (vite.child.exitCode === null && vite.child.signalCode === null) vite.child.kill('SIGTERM')
	await vite.exit
}

async function reservePort(): Promise<number> {
	return await new Promise((accept, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close()
				reject(new Error('Could not reserve a smoke-test port'))
				return
			}
			server.close((error) => {
				if (error) {
					reject(error)
					return
				}
				accept(address.port)
			})
		})
	})
}

async function waitForResponse(url: string, timeoutMs: number): Promise<Response> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url)
			if (response.ok) return response
			lastError = new Error(`HTTP ${response.status}`)
		} catch (error) {
			lastError = error
		}
		await new Promise((accept) => setTimeout(accept, 250))
	}
	throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

async function runPnpm(
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
	await runProcess(process.env.npm_execpath ?? 'pnpm', args, cwd, environment)
}

async function runPnpmCapture(args: string[], cwd: string): Promise<string> {
	const command = process.env.npm_execpath ?? 'pnpm'
	return await new Promise((accept, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		})
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) accept(stdout)
			else
				reject(new Error(`pnpm ${args.join(' ')} failed (${signal ?? code}): ${stderr || stdout}`))
		})
	})
}

async function runProcess(
	command: string,
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
	await new Promise<void>((accept, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			env: { ...process.env, ...environment },
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) accept()
			else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`))
		})
	})
}
