import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { loadPnpmEngine } from '../src/pnpm-engine.ts'
import { ManagedPackageStore } from '../src/store.ts'

it('materializes successive in-memory manifests and preserves publication on native resolution failure', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-native-materialize-'))
	const name = 'pluxel-native-contract-fixture'
	const archives = new Map<string, Buffer>()
	let store: ManagedPackageStore | undefined
	const registry = createServer((request, response) => {
		const path = request.url?.split('?')[0] ?? ''
		const archiveVersion = /^\/archive\/(.+)\.tgz$/u.exec(path)?.[1]
		if (archiveVersion && archives.has(archiveVersion)) {
			response
				.writeHead(200, { 'content-type': 'application/octet-stream' })
				.end(archives.get(archiveVersion))
			return
		}
		if (path !== `/${name}`) {
			response.writeHead(404).end()
			return
		}
		response.setHeader('content-type', 'application/json')
		response.end(
			JSON.stringify({
				name,
				'dist-tags': { latest: '2.0.0' },
				versions: Object.fromEntries(
					[...archives].map(([version, archive]) => [
						version,
						{
							name,
							version,
							dist: {
								tarball: `http://${request.headers.host}/archive/${version}.tgz`,
								shasum: createHash('sha1').update(archive).digest('hex'),
							},
						},
					]),
				),
			}),
		)
	})
	try {
		await Promise.all(
			['1.0.0', '2.0.0'].map(async (version) => {
				const directory = resolve(root, version)
				await mkdir(resolve(directory, 'package'), { recursive: true })
				await writeFile(
					resolve(directory, 'package/package.json'),
					JSON.stringify({ name, version, main: 'index.js' }),
				)
				await writeFile(
					resolve(directory, 'package/index.js'),
					`module.exports = ${JSON.stringify(version)}\n`,
				)
				await promisify(execFile)('tar', [
					'-czf',
					resolve(directory, 'package.tgz'),
					'-C',
					directory,
					'package',
				])
				archives.set(version, await readFile(resolve(directory, 'package.tgz')))
			}),
		)
		await new Promise<void>((ready) => registry.listen(0, '127.0.0.1', ready))
		const port = (registry.address() as { port: number }).port
		const rootDir = resolve(root, 'managed')
		await mkdir(rootDir)
		await writeFile(
			resolve(rootDir, '.npmrc'),
			`registry=http://127.0.0.1:${port}/\nstore-dir=${resolve(root, 'store')}\ncache-dir=${resolve(root, 'cache')}\nfetch-retries=0\n`,
		)
		store = new ManagedPackageStore(await loadPnpmEngine(), {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		await store.initialize()
		expect(await store.install([`${name}@1.0.0`])).toMatchObject({ ok: true })
		expect(
			JSON.parse(await readFile(resolve(rootDir, 'node_modules', name, 'package.json'), 'utf8')),
		).toMatchObject({ version: '1.0.0' })
		const first = await store.snapshot()
		const entry = resolve(first.entriesDir, first.packages[0]!.entryFile!)
		const firstPublication = await readFile(entry, 'utf8')
		expect(await store.install([`${name}@2.0.0`])).toMatchObject({ ok: true })
		expect(
			JSON.parse(await readFile(resolve(rootDir, 'node_modules', name, 'package.json'), 'utf8')),
		).toMatchObject({ version: '2.0.0' })
		const manifest = await readFile(resolve(rootDir, 'package.json'), 'utf8')
		const publication = await readFile(entry, 'utf8')
		expect(publication).not.toBe(firstPublication)
		expect(await store.install([`${name}@3.0.0`])).toMatchObject({ ok: false })
		expect(await readFile(resolve(rootDir, 'package.json'), 'utf8')).toBe(manifest)
		expect(await readFile(entry, 'utf8')).toBe(publication)
		expect(await store.remove([name])).toMatchObject({ ok: true })
		const removed = await store.snapshot()
		expect(removed.packages).toEqual([])
		await expect(readFile(entry)).rejects.toMatchObject({ code: 'ENOENT' })
	} finally {
		await store?.close()
		registry.closeAllConnections()
		await new Promise<void>((closed) => registry.close(() => closed()))
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
