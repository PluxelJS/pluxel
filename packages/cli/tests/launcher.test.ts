import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const pluxelBin = fileURLToPath(new URL('../bin/pluxel.mjs', import.meta.url))
const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	)
})

async function createProject(files: Record<string, string>) {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-cli-launcher-'))
	temporaryRoots.push(root)
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = resolve(root, relativePath)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, contents, 'utf8')
	}
	return root
}

function runNode(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const env = { ...process.env }
		delete env.NODE_OPTIONS
		delete env.NODE_PATH
		const child = spawn(process.execPath, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env,
		})
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('error', reject)
		child.on('close', (code) => {
			resolvePromise({ code: code ?? 1, stdout, stderr })
		})
	})
}

async function releaseBin() {
	const root = await createProject({
		'package.json': JSON.stringify({ name: '@pluxel/cli', type: 'module' }),
		'bin/pluxel.mjs': await readFile(pluxelBin, 'utf8'),
	})
	await symlink(resolve(dirname(pluxelBin), '../dist'), resolve(root, 'dist'))
	return resolve(root, 'bin/pluxel.mjs')
}

describe('pluxel bin launcher', () => {
	it('checks the pncat cwd binding before forwarding native arguments', async () => {
		const root = await createProject({
			'package.json': '{"name":"bound-consumer"}',
			'.pluxel/development.json': JSON.stringify({
				source: { kind: 'git', root: '/other-pluxel-checkout' },
			}),
		})
		for (const cwdArgs of [['--cwd', root], [`--cwd=${root}`]]) {
			const result = await runNode(
				[pluxelBin, 'pncat', 'clean', '--yes', '--no-install', ...cwdArgs],
				dirname(root),
			)
			expect(result.code).toBe(1)
			expect(result.stderr).toContain('Source mismatch')
			expect(result.stderr).toContain('/other-pluxel-checkout')
		}
	})
	it('rejects stale Git CLI code before executing the old artifact and accepts restored content', async () => {
		const packagePath = 'packages/cli'
		const root = await createProject({
			'.git/HEAD': 'ref: refs/heads/main\n',
			'vendor/pncat/src/sync.ts': 'export {}\n',
			'vendor/pncat/package.json': '{"name":"pncat"}',
			'tsconfig.cli-build.json': '{}',
			'pnpm-workspace.yaml': 'packages: [packages/*]\n',
			[`${packagePath}/package.json`]: JSON.stringify({ name: '@pluxel/cli', type: 'module' }),
			[`${packagePath}/src/cli.ts`]: 'export const version = 1\n',
			[`${packagePath}/scripts/build.mjs`]: '',
			[`${packagePath}/tsconfig.json`]: '{}',
			[`${packagePath}/tsdown.config.ts`]: 'export default {}\n',
			[`${packagePath}/bin/pluxel.mjs`]: await readFile(pluxelBin, 'utf8'),
			[`${packagePath}/bin/build-state.mjs`]: await readFile(
				resolve(dirname(pluxelBin), 'build-state.mjs'),
				'utf8',
			),
			[`${packagePath}/dist/cli.mjs`]: 'process.stdout.write("artifact executed")\n',
		})
		const packageRoot = resolve(root, packagePath)
		const executable = resolve(packageRoot, 'bin/pluxel.mjs')
		const run = () => runNode([executable, 'source', 'doctor'], root)
		const missingStamp = await run()
		expect(missingStamp.code).toBe(1)
		expect(missingStamp.stderr).toContain('CLI build is stale')
		expect(missingStamp.stdout).toBe('')
		const { cliSourceFingerprint } = await import(
			pathToFileURL(resolve(packageRoot, 'bin/build-state.mjs')).href
		)
		await writeFile(
			resolve(packageRoot, 'dist/source-fingerprint'),
			cliSourceFingerprint(packageRoot),
		)
		const current = await run()
		expect(current.stdout).toBe('artifact executed')
		await writeFile(resolve(packageRoot, 'src/cli.ts'), 'export const version = 2\n')
		const stale = await run()
		expect(stale.code).toBe(1)
		expect(stale.stdout).toBe('')
		expect(stale.stderr).toContain(`pnpm --dir "${root}" --filter @pluxel/cli build`)
		await writeFile(resolve(packageRoot, 'src/cli.ts'), 'export const version = 1\n')
		const restored = await run()
		expect(restored.stdout).toBe('artifact executed')
		await writeFile(
			resolve(root, 'pnpm-workspace.yaml'),
			'packages: [packages/*]\ncatalog: { yaml: ^2.0.0 }\n',
		)
		const stalePolicy = await run()
		expect(stalePolicy.stderr).toContain('CLI build is stale')
		await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n')
		await writeFile(resolve(root, 'vendor/pncat/src/sync.ts'), 'export const changed = true\n')
		const staleVendor = await run()
		expect(staleVendor.stderr).toContain('CLI build is stale')
	})

	it('keeps the Git CLI for ordinary documentation even with another local CLI', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({ devDependencies: { '@pluxel/cli': '*' } }),
			'node_modules/@pluxel/cli/package.json': JSON.stringify({
				name: '@pluxel/cli',
				bin: 'bad.mjs',
			}),
		})
		const result = await runNode([pluxelBin, 'docs'], root)
		expect(result.code).toBe(0)
		expect(result.stdout).toContain('Source: git')
	})

	it('delegates to a directly declared project-local CLI before loading global CLI state', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
			'node_modules/@pluxel/cli/package.json': JSON.stringify({
				name: '@pluxel/cli',
				version: '0.1.0',
				type: 'module',
				bin: { pluxel: 'bin/pluxel.mjs' },
			}),
			'node_modules/@pluxel/cli/bin/pluxel.mjs': [
				'process.stdout.write(JSON.stringify({',
				'  argv: process.argv.slice(1),',
				'  cwd: process.cwd(),',
				'  direct: Boolean(globalThis[Symbol.for("pluxel.cli.direct")]),',
				'}))',
				'',
			].join('\n'),
		})

		const result = await runNode([await releaseBin(), 'build'], root)
		const payload = JSON.parse(result.stdout) as { argv: string[]; cwd: string; direct: boolean }

		expect(result.stderr).toBe('')
		expect(result.code).toBe(0)
		expect(payload.cwd).toBe(root)
		expect(payload.argv[0]).toContain('node_modules/@pluxel/cli/bin/pluxel.mjs')
		expect(payload.argv.slice(1)).toEqual(['build'])
		expect(payload.direct).toBe(false)
	})

	it('does not fall back to the current CLI for ordinary commands when a declared local CLI is not installed', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
		})

		const result = await runNode([await releaseBin(), '--version'], root)

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('declares @pluxel/cli, but it is not installed')
	})

	it('uses the current independent CLI to bootstrap source workspaces before the local CLI is installed', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
		})

		const result = await runNode([pluxelBin, 'source', '--help'], root)

		expect(result.code).toBe(0)
		expect(result.stderr).toBe('')
		expect(result.stdout).toContain('Use registered source checkouts')
	})

	it('uses the calling CLI for source bootstrap even when an installed local CLI is incomplete', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
			'node_modules/@pluxel/cli/package.json': JSON.stringify({
				name: '@pluxel/cli',
				version: '0.1.0',
				type: 'module',
				bin: { pluxel: 'bin/pluxel.mjs' },
			}),
		})

		const result = await runNode([pluxelBin, 'source', '--help'], root)

		expect(result.code).toBe(0)
		expect(result.stderr).toBe('')
		expect(result.stdout).toContain('Use registered source checkouts')
	})

	it('lists the symlinked calling CLI checkout without registration even when a local CLI is installed', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({
				name: 'fixture',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
			'node_modules/@pluxel/cli/package.json': JSON.stringify({
				name: '@pluxel/cli',
				type: 'module',
				bin: { pluxel: 'bin/pluxel.mjs' },
			}),
			'node_modules/@pluxel/cli/bin/pluxel.mjs': 'throw new Error("unexpected local CLI")\n',
		})
		const registryPath = resolve(root, 'config/source-checkouts.json')
		const linkedBin = resolve(root, 'pluxel.mjs')
		await symlink(pluxelBin, linkedBin)
		const result = await runNode([linkedBin, 'source', 'list', '--registry', registryPath], root)

		expect(result.code).toBe(0)
		expect(result.stderr).toBe('')
		expect(result.stdout).toContain('https://github.com/PluxelJS/pluxel (cli)')
		expect(result.stdout).toContain(`checkout: ${resolve(dirname(pluxelBin), '../../..')}`)
		expect(existsSync(registryPath)).toBe(false)
	})

	it('does not resolve a CLI from outside the nearest independent project boundary', async () => {
		const root = await createProject({
			'node_modules/@pluxel/cli/package.json': JSON.stringify({
				name: '@pluxel/cli',
				version: '9.0.0',
				type: 'module',
				bin: { pluxel: 'bin/pluxel.mjs' },
			}),
			'node_modules/@pluxel/cli/bin/pluxel.mjs': 'process.stdout.write("unexpected parent CLI")\n',
			'consumer/.git/HEAD': 'ref: refs/heads/main\n',
			'consumer/package.json': JSON.stringify({
				name: 'consumer',
				version: '1.0.0',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
		})
		const consumer = resolve(root, 'consumer')

		const source = await runNode([pluxelBin, 'source', '--help'], consumer)
		const ordinary = await runNode([await releaseBin(), '--version'], consumer)

		expect(source.code).toBe(0)
		expect(source.stdout).toContain('Use registered source checkouts')
		expect(source.stdout).not.toContain('unexpected parent CLI')
		expect(ordinary.code).toBe(1)
		expect(ordinary.stderr).toContain('declares @pluxel/cli, but it is not installed')
	})
})
