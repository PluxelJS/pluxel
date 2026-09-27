import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	clearOxcResolutionCache,
	resolvePackageJsonPathWithOxc,
	resolveWithOxc,
} from '../../src/resolver/oxc'

const roots: string[] = []
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-oxc-resolver-'))
	roots.push(root)
	return root
}
afterEach(async () => {
	clearOxcResolutionCache()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveWithOxc', () => {
	it('keeps an absent package nullable but surfaces installed package and exports failures', async () => {
		const root = await fixture()
		expect(resolveWithOxc(root, 'not-installed')).toBeNull()
		const packageRoot = join(root, 'node_modules', 'fixture-pkg')
		await mkdir(packageRoot, { recursive: true })
		await writeFile(join(packageRoot, 'package.json'), '{broken')
		let badManifest: unknown
		try {
			resolveWithOxc(root, 'fixture-pkg')
		} catch (cause) {
			badManifest = cause
		}
		expect(badManifest).toBeInstanceOf(Error)
		expect((badManifest as Error).message).toContain(join(packageRoot, 'package.json'))
		expect((badManifest as Error).cause).toBeInstanceOf(SyntaxError)
		await writeFile(
			join(packageRoot, 'package.json'),
			JSON.stringify({
				name: 'fixture-pkg',
				exports: { '.': './index.js' },
			}),
		)
		await writeFile(join(packageRoot, 'index.js'), 'export const value = 1\n')
		clearOxcResolutionCache()
		expect(() => resolveWithOxc(root, 'fixture-pkg/private')).toThrow(
			join(packageRoot, 'package.json'),
		)
	})

	it('surfaces denied package self-references without an installed package directory', async () => {
		const root = await fixture()
		const manifestPath = join(root, 'package.json')
		await writeFile(
			manifestPath,
			JSON.stringify({ name: 'self-pkg', exports: { '.': './index.js' } }),
		)
		await writeFile(join(root, 'index.js'), 'export const value = 1\n')
		expect(() => resolveWithOxc(root, 'self-pkg/private')).toThrow(manifestPath)
	})

	it('preserves a manifest permission failure at the installed package path', async () => {
		if (process.platform === 'win32' || process.getuid?.() === 0) return
		const root = await fixture()
		const packageRoot = join(root, 'node_modules', 'fixture-pkg')
		const manifestPath = join(packageRoot, 'package.json')
		await mkdir(packageRoot, { recursive: true })
		await writeFile(manifestPath, JSON.stringify({ main: 'index.js' }))
		await chmod(manifestPath, 0)
		let failure: unknown
		try {
			resolveWithOxc(root, 'fixture-pkg')
		} catch (cause) {
			failure = cause
		}
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain(manifestPath)
		expect((failure as Error).cause).toMatchObject({ code: 'EACCES' })
	})

	it('keeps missing relative files nullable but rejects a broken owner manifest', async () => {
		const root = await fixture()
		await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
		expect(resolveWithOxc(root, './missing')).toBeNull()
		await writeFile(join(root, 'file.js'), 'export const value = 1\n')
		await writeFile(join(root, 'package.json'), '{broken')
		clearOxcResolutionCache()
		expect(() => resolveWithOxc(root, './file.js')).toThrow(join(root, 'package.json'))
	})

	it('reports denied package imports with owner and conditions', async () => {
		const root = await fixture()
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'fixture', imports: { '#allowed': './file.js' } }),
		)
		let failure: unknown
		try {
			resolveWithOxc(root, '#denied', { conditionNames: ['node', 'import'] })
		} catch (cause) {
			failure = cause
		}
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain(join(root, 'package.json'))
		expect((failure as Error).message).toContain('node')
		expect((failure as Error).cause).toBeInstanceOf(Error)
	})

	it('preserves invalid resolver configuration instead of reporting an absent module', () => {
		const invalid = { conditionNames: [42] as unknown as readonly string[] }
		let failure: unknown
		try {
			resolveWithOxc(process.cwd(), 'missing', invalid)
		} catch (cause) {
			failure = cause
		}
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain('missing')
		expect((failure as Error).cause).toBeInstanceOf(Error)
		expect(() => resolveWithOxc(process.cwd(), 'missing', invalid)).toThrow(
			'Cannot initialize OXC resolver',
		)
		expect(resolveWithOxc(process.cwd(), 'missing')).toBeNull()
	})
})

describe('resolvePackageJsonPathWithOxc', () => {
	it('uses package entry metadata when package.json is not exported', async () => {
		const root = await fixture()
		const pkgRoot = join(root, 'node_modules', 'fixture-pkg')
		await mkdir(pkgRoot, { recursive: true })
		await writeFile(
			join(pkgRoot, 'package.json'),
			JSON.stringify({
				name: 'fixture-pkg',
				version: '1.2.3',
				exports: {
					'.': './index.js',
				},
			}),
		)
		await writeFile(join(pkgRoot, 'index.js'), 'export const value = 1\n')

		expect(resolvePackageJsonPathWithOxc(root, 'fixture-pkg')).toBe(join(pkgRoot, 'package.json'))
	})
})
