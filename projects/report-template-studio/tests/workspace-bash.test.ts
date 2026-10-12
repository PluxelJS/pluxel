import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../src/backend/store'
import { runWorkspaceBash } from '../src/backend/workspace-bash'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'studio-bash-'))
	roots.push(root)
	const workspace = join(root, 'workspace')
	await mkdir(workspace)
	await writeFile(join(workspace, 'source.typ'), 'one\ntwo\n')
	const store = new WorkspaceStore(join(root, 'state'), '')
	await store.initialize()
	const project = await store.open(workspace)
	const run = (command: string, signal?: AbortSignal) =>
		runWorkspaceBash(store, project.id, command, () => {}, signal)
	return { root, workspace, store, project, run }
}
it('executes pipelines and persists create, append, recursive copy, rename and delete', async () => {
	const f = await fixture()
	const result = await f.run(
		'mkdir -p nested/a; cat source.typ | grep two > nested/a/result.typ; printf "three\\n" >> nested/a/result.typ; cp -r nested copied; mv copied renamed; rm -r nested; cat renamed/a/result.typ',
	)
	expect(result.exitCode).toBe(0)
	expect(result.stdout).toBe('two\nthree\n')
	expect(await readFile(join(f.workspace, 'renamed/a/result.typ'), 'utf8')).toBe(result.stdout)
	await expect(readFile(join(f.workspace, 'nested/a/result.typ'))).rejects.toThrow(/ENOENT/)
})
it('does not expose host paths, environment, links, network or executable runtimes', async () => {
	const f = await fixture()
	await writeFile(join(f.root, 'secret'), 'host-secret')
	for (const command of [
		'cat ../secret',
		'echo bad > /etc/outside',
		'cat C:\\Windows\\win.ini',
		'curl https://example.com',
		'node -e 1',
		'python3 -c 1',
		'js-exec "1"',
		'ln -s source.typ link',
	]) {
		const result = await f.run(command)
		expect(result.exitCode).not.toBe(0)
		expect(result.stdout).not.toContain('host-secret')
	}
	const environment = await f.run('env')
	expect(environment.stdout).not.toContain(f.root)
	await symlink(join(f.root, 'secret'), join(f.workspace, 'link'))
	await expect(f.run('cat link')).rejects.toThrow(/link/i)
})
it('rejects revision conflicts before replacing concurrent edits', async () => {
	const f = await fixture()
	const read = f.store.readFile.bind(f.store)
	f.store.readFile = async (id, path) => {
		const result = await read(id, path)
		await writeFile(join(f.workspace, path), 'external edit')
		return result
	}
	const result = await f.run('cat source.typ > copy.typ; echo replacement > source.typ')
	expect(result.exitCode).not.toBe(0)
	expect(result.stderr).toContain('File changed')
	expect(await readFile(join(f.workspace, 'source.typ'), 'utf8')).toBe('external edit')
})
it('reports binary/unsupported operations and retains successful writes on later failure', async () => {
	const f = await fixture()
	await writeFile(join(f.workspace, 'font.bin'), new Uint8Array([0, 255, 12]))
	const result = await f.run('echo saved > saved.typ; cp font.bin copy.bin')
	expect(result.exitCode).not.toBe(0)
	expect(result.stderr).toContain('Binary')
	expect(result.changed).toContain('saved.typ')
	expect(await readFile(join(f.workspace, 'saved.typ'), 'utf8')).toBe('saved\n')
	const moved = await f.run(
		'mkdir assets; mv font.bin assets/font.bin; mv assets moved; rm -r moved',
	)
	expect(moved.exitCode).toBe(0)
})
it('honors cancellation and bounds runaway loops and output', async () => {
	const f = await fixture()
	await expect(f.run('echo bad > canceled.typ', AbortSignal.abort())).rejects.toThrow(/abort/i)
	await expect(readFile(join(f.workspace, 'canceled.typ'))).rejects.toThrow(/ENOENT/)
	const loop = await f.run('while true; do :; done')
	expect(loop.exitCode).not.toBe(0)
	const output = await f.run('seq 1 100000')
	expect(output.stdout.length).toBeLessThanOrEqual(65536)
})

it('cancels in-flight execution before later filesystem mutations', async () => {
	const f = await fixture()
	const controller = new AbortController()
	const read = f.store.readFile.bind(f.store)
	f.store.readFile = async (id, path) => {
		const result = await read(id, path)
		controller.abort()
		return result
	}
	const result = await f.run('cat source.typ; echo bad > later.typ', controller.signal)
	expect(result.exitCode).toBe(124)
	expect(result.stderr).toMatch(/abort/i)
	await expect(readFile(join(f.workspace, 'later.typ'))).rejects.toThrow(/ENOENT/)
})
it('does not adopt concurrent descendant edits into a later directory delete', async () => {
	const f = await fixture()
	await mkdir(join(f.workspace, 'folder'))
	await writeFile(join(f.workspace, 'folder/user.typ'), 'old')
	const write = f.store.writeFile.bind(f.store)
	f.store.writeFile = async (id, input) => {
		const result = await write(id, input)
		await writeFile(join(f.workspace, 'folder/user.typ'), 'external edit')
		return result
	}
	const result = await f.run('echo new > folder/new.typ; rm -r folder')
	expect(result.exitCode).not.toBe(0)
	expect(await readFile(join(f.workspace, 'folder/user.typ'), 'utf8')).toBe('external edit')
	expect(result.changed).toContain('folder/new.typ')
})

it('edits source with sed in place and transforms JSON with jq', async () => {
	const f = await fixture()
	const result = await f.run(
		`sed -i 's/one/updated/' source.typ; printf '{"amount":7}' | jq '.amount * 2' > total.txt; cat source.typ total.txt`,
	)
	expect(result.exitCode).toBe(0)
	expect(result.stdout).toBe('updated\ntwo\n14\n')
})
