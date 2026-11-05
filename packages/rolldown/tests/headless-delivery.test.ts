import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import {
	cp,
	glob,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { publishPackageClosure, repositoryPackages } from '../../../scripts/repository-packages.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/headless-delivery/', import.meta.url))
const execFile = promisify(execFileCallback)

async function run(file: string, args: string[], cwd: string, env = process.env) {
	try {
		return await execFile(file, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
	} catch (cause) {
		const error = cause as Error & { stdout?: string; stderr?: string }
		throw new Error(`${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause })
	}
}

async function installedVersion(specifier: string, require: NodeJS.Require): Promise<string> {
	let directory = dirname(require.resolve(specifier))
	for (;;) {
		try {
			const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
			if (manifest.name === specifier) return manifest.version as string
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		const parent = dirname(directory)
		if (parent === directory) throw new Error(`No installed package manifest for ${specifier}`)
		directory = parent
	}
}

it('delivers a native libSQL HTTP application through independent standalone and modules installations', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'pluxel-headless-delivery-'))
	const source = join(temporary, 'source')
	const packed = join(temporary, 'packages')
	const deliveries = join(temporary, 'deliveries')
	const acceptance = join(temporary, 'acceptance')
	try {
		await Promise.all([mkdir(source), mkdir(packed), mkdir(deliveries), mkdir(acceptance)])
		const local = publishPackageClosure(repositoryPackages, [
			'@pluxel/core',
			'@pluxel/host',
			'@pluxel/services',
			'@pluxel/rolldown',
		])
		const overrides: Record<string, string> = {}
		const versions = new Map<string, string>()
		for (const item of local) {
			const tarball = join(
				packed,
				`${item.manifest.name.replaceAll('/', '-').replace('@', '')}.tgz`,
			)
			await run('pnpm', ['pack', '--out', tarball], item.packageRoot)
			overrides[item.manifest.name] = `file:${tarball}`
			versions.set(item.manifest.name, item.manifest.version)
		}
		const servicesRequire = createRequire(join(workspace, 'packages/services/package.json'))
		const elysiaRequire = createRequire(servicesRequire.resolve('elysia'))
		const buildRequire = createRequire(join(workspace, 'packages/rolldown/package.json'))
		const dependencies: Record<string, string> = {}
		for (const name of ['@pluxel/core', '@pluxel/host', '@pluxel/services'])
			dependencies[name] = versions.get(name)!
		for (const name of ['@libsql/client', 'elysia'])
			dependencies[name] = await installedVersion(name, servicesRequire)
		for (const name of ['typebox', 'exact-mirror', 'openapi-types'])
			dependencies[name] = await installedVersion(name, elysiaRequire)
		dependencies.valibot = await installedVersion('valibot', buildRequire)
		const devDependencies = {
			'@pluxel/rolldown': versions.get('@pluxel/rolldown')!,
			'vite-plus': await installedVersion('vite-plus', buildRequire),
		}
		const manifest = {
			name: '@example/headless-documents',
			version: '1.0.0',
			type: 'module',
			dependencies,
		}
		await writeFile(join(source, 'package.json'), JSON.stringify({ ...manifest, devDependencies }))
		await writeFile(
			join(source, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides }),
		)
		await run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], source)
		for (const name of Object.keys(dependencies))
			expect(await realpath(join(source, 'node_modules', name))).not.toContain(workspace)
		const installedPackages = await readdir(join(source, 'node_modules/.pnpm'))
		expect(
			installedPackages.filter((name) =>
				/^(?:@pluxel\+(?:commands|workbench)@|pg@|@electric-sql\+pglite@)/.test(name),
			),
		).toEqual([])
		await cp(fixture, source, { recursive: true })
		await writeFile(
			join(source, 'build.mjs'),
			`
import {build} from 'vite-plus/pack';
import {pluxel} from '@pluxel/rolldown';
import {createDistributionManifest} from '@pluxel/rolldown/distribution';
import {cp} from 'node:fs/promises';
for (const delivery of ['standalone', 'modules']) {
 const options = delivery === 'standalone'
  ? {delivery,variant:'headless',managedDatabaseDrivers:[],residualDependencies:{packages:['@libsql/client']}}
  : {delivery,variant:'headless'};
 await build({entry:'app.ts',outDir:delivery,plugins:[pluxel(options)],config:false});
 await cp('public',delivery+'/public',{recursive:true});
 await cp('start.mjs',delivery+'/start.mjs');
 await createDistributionManifest(delivery);
}
`,
		)
		await run(process.execPath, ['build.mjs'], source)
		const nativeFiles = await Array.fromAsync(
			glob('standalone/node_modules/**/*.node', { cwd: source }),
		)
		expect(nativeFiles.some((file) => file.includes('@libsql/'))).toBe(true)
		const distribution = JSON.parse(
			await readFile(join(source, 'standalone/pluxel-distribution.json'), 'utf8'),
		)
		expect(JSON.stringify(distribution)).toContain('.node')
		const deployment = JSON.parse(
			await readFile(join(source, 'standalone/pluxel-deployment.json'), 'utf8'),
		)
		expect(deployment.residualDependencies.packages).toContain('libsql')
		expect(deployment.residualDependencies.packages).not.toContain('pg')
		expect(deployment.residualDependencies.packages).not.toContain('@electric-sql/pglite')
		for (const file of ['verify.mjs', 'guard.mjs'])
			await cp(join(fixture, file), join(acceptance, file))
		for (const delivery of ['standalone', 'modules']) {
			const directory = join(deliveries, delivery)
			await mkdir(directory)
			await rename(join(source, delivery), join(directory, 'application'))
			if (delivery === 'modules') {
				await writeFile(
					join(directory, 'package.json'),
					JSON.stringify({ private: true, type: 'module', dependencies }),
				)
				await writeFile(
					join(directory, 'pnpm-workspace.yaml'),
					JSON.stringify({ packages: ['.'], overrides }),
				)
				await run('pnpm', ['install', '--prod', '--prefer-offline', '--ignore-scripts'], directory)
				for (const name of Object.keys(dependencies)) {
					const installed = await realpath(join(directory, 'node_modules', name))
					assert.ok(installed.startsWith(directory + '/'), installed)
				}
			}
		}
		// Neither delivery can read the original compiler installation or application sources.
		await rm(source, { recursive: true, force: true })
		for (const delivery of ['standalone', 'modules']) {
			const directory = join(deliveries, delivery)
			const data = join(temporary, `data-${delivery}`)
			const result = await run(
				process.execPath,
				[join(acceptance, 'verify.mjs'), delivery, join(directory, 'application'), data],
				directory,
				{ ...process.env, FORBIDDEN_ROOT: workspace },
			)
			expect(result.stdout).toContain(`HEADLESS_DELIVERY_OK ${delivery}`)
			if (process.env.PLUXEL_HEADLESS_IMAGE) {
				const containerData = join(temporary, `container-${delivery}`)
				await mkdir(containerData)
				const container = await run(
					'docker',
					[
						'run',
						'--rm',
						'--network=none',
						'--read-only',
						'-v',
						`${directory}:/delivery:ro`,
						'-v',
						`${acceptance}:/acceptance:ro`,
						'-v',
						`${containerData}:/data:rw`,
						process.env.PLUXEL_HEADLESS_IMAGE,
						'node',
						'/acceptance/verify.mjs',
						delivery,
						'/delivery/application',
						'/data',
					],
					directory,
				)
				assert.ok(container.stdout.includes(`HEADLESS_DELIVERY_OK ${delivery}`), container.stdout)
				process.stdout.write(container.stdout)
			}
			process.stdout.write(result.stdout)
		}
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
}, 240_000)
