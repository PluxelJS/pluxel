import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('pluxel bin launcher', () => {
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

		const result = await runNode([pluxelBin, 'build'], root)
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

		const result = await runNode([pluxelBin, '--version'], root)

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

	it('does not hide an incomplete installed local CLI during source bootstrap', async () => {
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

		expect(result.code).toBe(1)
		expect(result.stderr).toContain('Resolved project-local @pluxel/cli bin, but it is missing')
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
		const ordinary = await runNode([pluxelBin, '--version'], consumer)

		expect(source.code).toBe(0)
		expect(source.stdout).toContain('Use registered source checkouts')
		expect(source.stdout).not.toContain('unexpected parent CLI')
		expect(ordinary.code).toBe(1)
		expect(ordinary.stderr).toContain('declares @pluxel/cli, but it is not installed')
	})
})
