import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'
import { checkDevelopmentWorkspace } from '../src/workspace-setup'

const cliSource = fileURLToPath(new URL('../../cli/', import.meta.url))
const run = promisify(execFile)
const workspaceFiles = {
	'package.json': JSON.stringify({ private: true, packageManager: 'pnpm@11.25.0' }),
	'pnpm-workspace.yaml': 'packages:\n  - host\n',
	'host/package.json': JSON.stringify({
		name: '@fixture/host',
		devDependencies: { '@pluxel/cli': '1.1.0' },
	}),
	'host/web/index.html': '<div id="root"></div>',
}

/** An actual release CLI implementation and resources, with its existing installed dependencies. */
async function installCli(root: string): Promise<string> {
	const cli = resolve(root, 'node_modules/@pluxel/cli')
	await mkdir(cli, { recursive: true })
	await copyFile(resolve(cliSource, 'package.json'), resolve(cli, 'package.json'))
	await cp(resolve(cliSource, 'bin'), resolve(cli, 'bin'), { recursive: true })
	await cp(resolve(cliSource, 'dist'), resolve(cli, 'dist'), { recursive: true })
	await symlink(resolve(cliSource, 'node_modules'), resolve(cli, 'node_modules'), 'dir')
	return resolve(cli, 'bin/pluxel.mjs')
}

async function setup(cli: string, root: string): Promise<void> {
	await run(process.execPath, [cli, 'workspace', 'setup', '--root', root], {
		cwd: root,
		timeout: 30_000,
	})
}

it('uses the workspace doctor inputs when a member declares the installed CLI', async () => {
	await using fixture = await createDiskFixture(workspaceFiles)
	const cli = await installCli(fixture.path)
	await setup(cli, fixture.path)
	const statePath = resolve(fixture.path, '.pluxel/development.json')
	const before = await readFile(statePath, 'utf8')
	await expect(
		checkDevelopmentWorkspace(resolve(fixture.path, 'host/web')),
	).resolves.toBeUndefined()
	expect(await readFile(statePath, 'utf8')).toBe(before)
	expect(existsSync(resolve(fixture.path, 'host/.pluxel/development.json'))).toBe(false)

	const incomplete = JSON.stringify({ ...JSON.parse(before), complete: false })
	await writeFile(statePath, incomplete)
	await expect(checkDevelopmentWorkspace(resolve(fixture.path, 'host/web'))).rejects.toMatchObject({
		message: expect.stringContaining(`check failed at ${fixture.path}:`),
		cause: expect.objectContaining({
			code: 1,
			killed: false,
			signal: null,
			cmd: expect.stringContaining(`doctor --root ${fixture.path}`),
			stderr: expect.stringContaining('Development setup incomplete'),
		}),
	})
	expect(await readFile(statePath, 'utf8')).toBe(incomplete)
}, 40_000)

it('checks an explicitly configured child with the parent workspace CLI', async () => {
	await using fixture = await createDiskFixture(workspaceFiles)
	const cli = await installCli(fixture.path)
	await setup(cli, fixture.path)
	const child = resolve(fixture.path, 'host')
	await setup(cli, child)
	const statePath = resolve(child, '.pluxel/development.json')
	const before = await readFile(statePath, 'utf8')
	await expect(checkDevelopmentWorkspace(resolve(child, 'web'))).rejects.toMatchObject({
		message: expect.stringContaining(`check failed at ${child}:`),
		cause: expect.objectContaining({
			cmd: expect.stringContaining(`doctor --root ${child}`),
			stderr: expect.stringContaining('Pluxel workspaces must declare members and catalogs'),
		}),
	})
	expect(await readFile(statePath, 'utf8')).toBe(before)
}, 40_000)

it.each(['.git', 'pnpm-lock.yaml'])(
	'does not borrow a CLI across the nested %s boundary',
	async (marker) => {
		await using fixture = await createDiskFixture({
			...workspaceFiles,
			'independent/package.json': JSON.stringify({ devDependencies: { '@pluxel/cli': '1.1.0' } }),
			[`independent/${marker}`]: '',
			'independent/web/index.html': '<div id="root"></div>',
		})
		const cli = await installCli(fixture.path)
		await setup(cli, fixture.path)
		const independent = resolve(fixture.path, 'independent')
		await expect(checkDevelopmentWorkspace(resolve(independent, 'web'))).rejects.toThrow(
			`Pluxel development setup missing at ${independent}.`,
		)
		expect(existsSync(resolve(independent, '.pluxel/development.json'))).toBe(false)
	},
	40_000,
)

it('keeps an unconfigured fixture outside development setup even when a CLI is installed', async () => {
	await using fixture = await createDiskFixture({
		...workspaceFiles,
		'host/package.json': JSON.stringify({ name: '@fixture/host' }),
	})
	await installCli(fixture.path)
	await expect(
		checkDevelopmentWorkspace(resolve(fixture.path, 'host/web')),
	).resolves.toBeUndefined()
	expect(existsSync(resolve(fixture.path, '.pluxel'))).toBe(false)
	expect(existsSync(resolve(fixture.path, 'AGENTS.md'))).toBe(false)
})
