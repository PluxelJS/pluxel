import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

const pluxelBin = fileURLToPath(new URL('../bin/pluxel.mjs', import.meta.url))
const execute = promisify(execFile)
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

async function runNode(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env }
	delete env.NODE_OPTIONS
	delete env.NODE_PATH
	try {
		return { ...(await execute(process.execPath, args, { cwd, env, timeout: 4_000 })), code: 0 }
	} catch (error) {
		if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number')
			throw error
		return error as Error & { code: number; stdout: string; stderr: string }
	}
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
	it.each([
		{ argv: ['script'], boundary: 'missing script subcommand' },
		{ argv: ['script', '--unknown'], boundary: 'unknown option on the script command' },
		{ argv: ['script', 'run'], boundary: 'missing script positional argument' },
		{ argv: ['script', 'run', 'task.ts'], boundary: 'missing required script option' },
		{ argv: ['script', 'result'], boundary: 'invalid receipt selection inside a command' },
		{ argv: ['dev', '--profile', 'app', 'statuz'], boundary: 'unknown dev subcommand' },
		{ argv: ['dev', '--', 'statuz'], boundary: 'unknown dev subcommand after --' },
		{ argv: ['dev', 'status', '--root'], boundary: 'missing value for a CLI-owned option' },
		{ argv: ['dev', 'run', 'task.ts', '--receipt-file'], boundary: 'missing SDK option value' },
		{ argv: ['dev', 'instances', 'unexpected'], boundary: 'unexpected dev positional argument' },
		{ argv: ['dev', 'sync', '--unknown'], boundary: 'unknown option on a dev subcommand' },
	])('prints one control JSON error for $boundary', async ({ argv }) => {
		const result = await runNode([await releaseBin(), ...argv], tmpdir())
		expect(result.code).toBe(1)
		expect(result.stderr).toBe('')
		expect(result.stdout.trim().split('\n')).toHaveLength(1)
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: 'invalid_input', message: expect.any(String) },
		})
	})

	it.each([
		['source', 'unregister'],
		['dev', '--root'],
	])('preserves non-control validation output for %j', async (...argv) => {
		const result = await runNode([await releaseBin(), ...argv], tmpdir())
		expect(result.code).toBe(1)
		expect(result.stderr).not.toBe('')
		expect(() => JSON.parse(result.stdout)).toThrow(SyntaxError)
	})

	it('checks the dev --root source binding before loading CLI code', async () => {
		const root = await createProject({
			'package.json': '{"name":"bound-consumer"}',
			'.pluxel/development.json': JSON.stringify({
				source: { kind: 'git', root: '/other-pluxel-checkout' },
			}),
		})
		for (const selector of [['--root', root], [`--root=${root}`]]) {
			const result = await runNode([pluxelBin, 'dev', 'status', ...selector], dirname(root))
			expect(result.code).toBe(1)
			expect(result.stderr).toContain('Source mismatch')
			expect(result.stderr).toContain('/other-pluxel-checkout')
		}
	})

	it.each([
		['dev', '--root'],
		['pncat', '--cwd'],
		['build', '--root'],
	])('stops reading %s source selectors at --', async (command, option) => {
		const root = await createProject({
			'package.json': '{"name":"bound-consumer"}',
			'.pluxel/development.json': JSON.stringify({
				source: { kind: 'git', root: '/other-pluxel-checkout' },
			}),
			'other/.git/HEAD': 'ref: refs/heads/main\n',
		})
		for (const selector of [
			[option, resolve(root, 'other')],
			[`${option}=${resolve(root, 'other')}`],
		]) {
			const result = await runNode([pluxelBin, command, '--', ...selector], root)
			expect(result.code).toBe(1)
			expect(result.stderr).toContain('Source mismatch')
			expect(result.stderr).toContain('/other-pluxel-checkout')
		}
	})

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
			'tsconfig.json': '{}',
			'tsconfig.cli-build.json': '{}',
			'scripts/vite-tasks.ts': 'export {}\n',
			'scripts/repository-packages.mjs': 'export {}\n',
			'packages/core/package.json': '{"name":"@pluxel/core","version":"1.1.0"}',
			'vite.config.ts': 'export default {}\n',
			'mise.toml': '',
			'pnpm-workspace.yaml': 'packages: [packages/*]\n',
			[`${packagePath}/package.json`]: JSON.stringify({ name: '@pluxel/cli', type: 'module' }),
			[`${packagePath}/src/cli.ts`]: 'export const version = 1\n',
			[`${packagePath}/scripts/build.mjs`]: '',
			[`${packagePath}/templates/plugin/pnpm-workspace.yaml`]: 'catalog: {}\n',
			[`${packagePath}/tsconfig.json`]: '{}',
			[`${packagePath}/tsdown.config.ts`]: 'export default {}\n',
			[`${packagePath}/vite.config.ts`]: 'export default {}\n',
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
		const built = cliSourceFingerprint(packageRoot)
		await writeFile(resolve(packageRoot, 'dist/source-fingerprint'), built)
		await writeFile(resolve(packageRoot, 'src/cli.ts'), 'export const version = 2\n')
		const stale = await run()
		expect(stale.code).toBe(1)
		expect(stale.stdout).toBe('')
		expect(stale.stderr).toContain(`cd "${root}" && vp run @pluxel/cli#compile`)
		await writeFile(resolve(packageRoot, 'src/cli.ts'), 'export const version = 1\n')
		const restored = await run()
		expect(restored.code).toBe(0)
		expect(restored.stdout).toBe('artifact executed')
		for (const [path, changed] of [
			['packages/core/package.json', '{"name":"@pluxel/core","version":"1.2.0"}'],
			[`${packagePath}/templates/plugin/pnpm-workspace.yaml`, 'catalog: { yaml: ^2.0.0 }\n'],
			['pnpm-workspace.yaml', 'packages: [packages/*]\ncatalog: { yaml: ^2.0.0 }\n'],
			['vendor/pncat/src/sync.ts', 'export const changed = true\n'],
		] as const) {
			const file = resolve(root, path)
			const original = await readFile(file)
			await writeFile(file, changed)
			expect(cliSourceFingerprint(packageRoot)).not.toBe(built)
			await writeFile(file, original)
		}
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

	it('permits source bootstrap before the project-local CLI is installed', async () => {
		const root = await createProject({
			'package.json': JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				devDependencies: { '@pluxel/cli': '0.1.0' },
			}),
		})

		const launcher = await releaseBin()
		const ordinary = await runNode([launcher, '--version'], root)
		expect(ordinary.code).toBe(1)
		expect(ordinary.stderr).toContain('declares @pluxel/cli, but it is not installed')

		const bootstrap = await runNode([launcher, 'source', '--help'], root)
		expect(bootstrap.code).toBe(0)
		expect(bootstrap.stderr).toBe('')
		expect(bootstrap.stdout).toContain('Use registered source checkouts')
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

		const result = await runNode([await releaseBin(), 'source', '--help'], root)

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
