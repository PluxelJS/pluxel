import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { encodeControlData, renderPluginDescriptors } from '@pluxel/host/agent'
import { expect, it, vi } from 'vitest'
import { ScriptInputs } from '../src/script-inputs'
import { compileScript } from '../src/scripts'

async function fixture() {
	const directory = await mkdtemp(join(import.meta.dirname, '.script-inputs-'))
	for (const name of ['a', 'b']) await mkdir(join(directory, name))
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({ name: 'script-inputs-fixture', type: 'module' }),
	)
	await writeFile(
		join(directory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2023',
				module: 'ESNext',
				moduleResolution: 'Bundler',
				strict: true,
				skipLibCheck: true,
			},
		}),
	)
	await writeFile(join(directory, 'a/value.mjs'), 'export const value = () => 41')
	await writeFile(join(directory, 'a/value.d.mts'), 'export declare const value: () => number')
	await writeFile(join(directory, 'b/value.mjs'), 'export const value = () => "B"')
	await writeFile(join(directory, 'b/value.d.mts'), 'export declare const value: () => string')
	await writeFile(
		join(directory, 'script.ts'),
		'import {value} from "./current/value.mjs"; export default ():number => value()',
	)
	await symlink('a', join(directory, 'current'), 'dir')
	return {
		directory,
		async switchToB() {
			await symlink('b', join(directory, 'next'), 'dir')
			await rename(join(directory, 'next'), join(directory, 'current'))
		},
		[Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
	}
}

it('pins a lexical symlink directory and aliases before reading declaration siblings', async () => {
	await using files = await fixture()
	const inputs = new ScriptInputs()
	expect(inputs.read(join(files.directory, 'current/value.mjs'))).toContain('41')
	await files.switchToB()
	expect(inputs.read(join(files.directory, 'current/value.d.mts'))).toContain('number')
	expect(inputs.read(join(files.directory, 'a/value.mjs'))).toContain('41')
	expect(inputs.snapshot().get(join(files.directory, 'current/value.mjs'))).toBe(
		inputs.snapshot().get(join(files.directory, 'a/value.mjs')),
	)
})

it('checks declarations for the bundled input when current changes between Rolldown and native checking', async () => {
	await using files = await fixture()
	const original = ScriptInputs.prototype.check
	const check = vi.spyOn(ScriptInputs.prototype, 'check').mockImplementationOnce(async function (
		this: ScriptInputs,
		file: string,
	) {
		await files.switchToB()
		await original.call(this, file)
		expect(this.snapshot().get(join(files.directory, 'current/value.d.mts'))).toContain('number')
	})
	try {
		const artifact = await compileScript({ file: join(files.directory, 'script.ts') })
		const compiled = new Function(artifact.code)() as { default(): number }
		expect(compiled.default()).toBe(41)
		expect(check).toHaveBeenCalledOnce()
	} finally {
		check.mockRestore()
	}
}, 30000)

it('rejects package exports switching the checker to another control declaration after bundling', async () => {
	await using files = await fixture()
	const packageRoot = join(files.directory, 'node_modules/control-inputs')
	const definition = {
		entry: { kind: 'package-root' as const, packageName: 'control-inputs' },
		exportName: 'Counter',
	}
	const hash = (value: string) => createHash('sha256').update(value).digest('hex')
	for (const name of ['a', 'b']) {
		const directory = join(packageRoot, name)
		await mkdir(directory, { recursive: true })
		const contracts = { config: null as null, instance: `sha256:${name.repeat(64)}` }
		const definitions = [{ definition, exportName: 'Counter', contracts, source: 'fixture' }]
		const contents = {
			'index.mjs': renderPluginDescriptors([
				{ exportName: 'Counter', descriptor: { format: 1, definition, contracts } },
			]),
			'index.d.mts': 'export declare const Counter: {readonly format:1}',
		}
		const unsigned = {
			format: 1,
			compiler: 'script-input-test',
			definitions,
			files: Object.entries(contents).map(([path, content]) => ({
				path,
				size: Buffer.byteLength(content),
				sha256: hash(content),
			})),
		}
		const manifest = { ...unsigned, snapshot: `sha256:${hash(encodeControlData(unsigned))}` }
		for (const [path, content] of Object.entries({
			...contents,
			'manifest.json': `${encodeControlData(manifest)}\n`,
		}))
			await writeFile(join(directory, path), content)
	}
	const packageJson = (name: string) =>
		JSON.stringify({
			name: 'control-inputs',
			version: '1.0.0',
			type: 'module',
			exports: { './control': { types: `./${name}/index.d.mts`, default: `./${name}/index.mjs` } },
		})
	await writeFile(join(packageRoot, 'package.json'), packageJson('a'))
	await writeFile(
		join(files.directory, 'script.ts'),
		'import {Counter} from "control-inputs/control"; export default () => Counter.format',
	)
	const original = ScriptInputs.prototype.check
	const check = vi.spyOn(ScriptInputs.prototype, 'check').mockImplementationOnce(async function (
		this: ScriptInputs,
		file: string,
	) {
		await writeFile(join(packageRoot, 'package.json'), packageJson('b'))
		await original.call(this, file)
	})
	try {
		await expect(compileScript({ file: join(files.directory, 'script.ts') })).rejects.toMatchObject(
			{
				code: 'typecheck_failed',
				message: expect.stringContaining('control declaration paired with its bundled module'),
			},
		)
	} finally {
		check.mockRestore()
	}
}, 30000)
