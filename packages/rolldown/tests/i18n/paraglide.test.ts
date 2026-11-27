import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixture } from 'fs-fixture'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import {
	compilePluxelParaglide,
	PLUXEL_PARAGLIDE_OUTDIR,
	PLUXEL_PARAGLIDE_SETTINGS,
	readPluxelParaglideProject,
} from '../../src/i18n/paraglide.ts'

const require = createRequire(import.meta.url)
const tsc = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const messageFormat = fileURLToPath(import.meta.resolve('@inlang/plugin-message-format'))
const packageManifest = JSON.stringify({
	type: 'module',
	imports: {
		'#i18n': './.pluxel/i18n/index.js',
		'#i18n/messages': './.pluxel/i18n/messages.js',
	},
})

function settings(pathPattern: unknown, options: { locales?: string[]; modules?: string[] } = {}) {
	return JSON.stringify({
		baseLocale: 'en',
		locales: options.locales ?? ['en', 'zh', 'zh-Hant', 'zh-Hant-HK', 'zh-CN'],
		modules: options.modules ?? [messageFormat],
		'plugin.inlang.messageFormat': { pathPattern },
	})
}

function runModule(packageRoot: string, code: string): unknown {
	return JSON.parse(
		execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
			cwd: packageRoot,
			encoding: 'utf8',
		}),
	)
}

describe('package Paraglide compiler', () => {
	it('isolates concurrent packages and makes native messages and locale types available on a clean checkout', async () => {
		await using fixture = await createFixture({
			'first/package.json': packageManifest,
			[`first/${PLUXEL_PARAGLIDE_SETTINGS}`]: settings('./messages/{locale}.json'),
			'first/messages/en.json': JSON.stringify({
				hello: 'Hello {name}',
				groups: { count: '{count} groups' },
			}),
			'first/messages/zh-CN.json': JSON.stringify({
				hello: '你好 {name}',
				groups: { count: '{count} 组' },
			}),
			'first/types.ts': [
				"import { baseLocale, m, resolveLocale, type Locale } from '#i18n'",
				"import { hello } from '#i18n/messages'",
				"const base: 'en' = baseLocale",
				'const locale: Locale = resolveLocale(undefined)',
				"m['groups.count']({ count: 3 }, { locale })",
				"hello({ name: 'Plugin' }, { locale: base })",
				'// @ts-expect-error message input must contain the declared name',
				'm.hello({}, { locale })',
				'// @ts-expect-error locale must be supported by this package',
				"m.hello({ name: 'Plugin' }, { locale: 'fr' })",
			].join('\n'),
			'second/package.json': packageManifest,
			[`second/${PLUXEL_PARAGLIDE_SETTINGS}`]: settings(
				['./catalogs/{locale}/shared.json', './catalogs/{languageTag}/plugin.json'],
				{ locales: ['en', 'de'] },
			),
			'second/catalogs/en/shared.json': JSON.stringify({ hello: 'Shared' }),
			'second/catalogs/en/plugin.json': JSON.stringify({ hello: 'Plugin override' }),
			'second/catalogs/fr/shared.json': '{}',
			'second/catalogs/en/ignored.json': '{}',
		})

		const firstRoot = resolve(fixture.path, 'first')
		const secondRoot = resolve(fixture.path, 'second')
		const [first, second, joined] = await Promise.all([
			compilePluxelParaglide(firstRoot),
			compilePluxelParaglide(secondRoot),
			compilePluxelParaglide(firstRoot),
		])
		expect(first).toBeDefined()
		expect(second).toBeDefined()
		expect(joined).toBe(first)
		expect(first?.outdir).toBe(resolve(firstRoot, PLUXEL_PARAGLIDE_OUTDIR))
		expect(second?.fingerprint).not.toBe(first?.fingerprint)
		expect(second?.sources).toEqual([
			resolve(secondRoot, 'catalogs/en/plugin.json'),
			resolve(secondRoot, 'catalogs/en/shared.json'),
			resolve(secondRoot, PLUXEL_PARAGLIDE_SETTINGS),
		])
		expect(second?.watchRoots).toContain(resolve(secondRoot, 'catalogs/de'))
		expect(second?.matchesSource(resolve(secondRoot, 'catalogs/de/plugin.json'))).toBe(true)
		expect(second?.matchesSource(resolve(secondRoot, 'catalogs/en/ignored.json'))).toBe(false)
		expect(second?.matchesSource(resolve(secondRoot, 'catalogs/fr/shared.json'))).toBe(false)

		expect(
			runModule(
				firstRoot,
				`import { m, resolveLocale } from '#i18n'
				const locale = resolveLocale(' ZH_cn ')
				console.log(JSON.stringify([
					m.hello({ name: 'Plugin' }, { locale }),
					m['groups.count']({ count: 3 }, { locale }),
					...['zh-Hant-HK', 'zh_Hant_TW', 'zh-SG', 'es-MX', null].map(resolveLocale),
				]))`,
			),
		).toEqual(['你好 Plugin', '3 组', 'zh-Hant-HK', 'zh-Hant', 'zh', 'en', 'en'])
		expect(
			runModule(
				secondRoot,
				`import { m } from '#i18n'
				console.log(JSON.stringify(m.hello()))`,
			),
		).toBe('Plugin override')
		execFileSync(
			process.execPath,
			[
				tsc,
				'--noEmit',
				'--strict',
				'--skipLibCheck',
				'--module',
				'ESNext',
				'--moduleResolution',
				'Bundler',
				'types.ts',
			],
			{ cwd: firstRoot, stdio: 'pipe' },
		)
	})

	it('keeps last successful output on input failure and repairs stale or missing output', async () => {
		await using fixture = await createFixture({
			[PLUXEL_PARAGLIDE_SETTINGS]: settings('./translations/{locale}.json', {
				locales: ['en', 'de'],
			}),
			'translations/en.json': '{"hello":"Hello"}',
			'translations/de.json': '{"hello":"Hallo"}',
		})
		const initial = await compilePluxelParaglide(fixture.path)
		const outdir = resolve(fixture.path, PLUXEL_PARAGLIDE_OUTDIR)
		const index = resolve(outdir, 'index.js')
		const declaration = resolve(outdir, 'index.d.ts')
		const time = new Date('2000-01-01T00:00:00Z')
		await Promise.all([utimes(index, time, time), utimes(declaration, time, time)])
		const translation = resolve(fixture.path, 'translations/de.json')
		const original = await readFile(resolve(outdir, 'messages/de.js'), 'utf8')

		await writeFile(translation, '{"hello":')
		const discoverable = await readPluxelParaglideProject(fixture.path)
		expect(discoverable?.sources).toContain(translation)
		await expect(compilePluxelParaglide(fixture.path)).rejects.toThrow('Failed to compile')
		expect(await readFile(resolve(outdir, 'messages/de.js'), 'utf8')).toBe(original)

		await writeFile(translation, '{"hello":"Guten Tag"}')
		const changed = await compilePluxelParaglide(fixture.path)
		expect(changed?.fingerprint).not.toBe(initial?.fingerprint)
		expect(await readFile(resolve(outdir, 'messages/de.js'), 'utf8')).toContain('Guten Tag')
		const [runtimeEntry, declarations] = await Promise.all([stat(index), stat(declaration)])
		expect(runtimeEntry.mtimeMs).toBe(time.valueOf())
		expect(declarations.mtimeMs).toBe(time.valueOf())
		expect(await compilePluxelParaglide(fixture.path)).toBe(changed)

		await rm(resolve(outdir, 'runtime.js'))
		const repaired = await compilePluxelParaglide(fixture.path)
		expect(repaired?.fingerprint).toBe(changed?.fingerprint)
		expect(await readFile(resolve(outdir, 'runtime.js'), 'utf8')).not.toContain('node:async_hooks')

		await writeFile(
			resolve(fixture.path, PLUXEL_PARAGLIDE_SETTINGS),
			settings('./translations/{locale}.json', { locales: ['en'] }),
		)
		await compilePluxelParaglide(fixture.path)
		await expect(stat(resolve(outdir, 'messages/de.js'))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it.each([{ admin: './messages/{locale}/admin.json' }, './messages/{locale}/*.json'])(
		'fails settings with unsupported pathPattern %j',
		async (pathPattern) => {
			await using fixture = await createFixture({
				[PLUXEL_PARAGLIDE_SETTINGS]: settings(pathPattern),
			})
			await expect(compilePluxelParaglide(fixture.path)).rejects.toThrow(
				'list each split catalog explicitly',
			)
		},
	)

	it('fails a declared module import before publishing generated output', async () => {
		await using fixture = await createFixture({
			[PLUXEL_PARAGLIDE_SETTINGS]: settings('./messages/{locale}.json', {
				modules: ['./missing-module.js'],
			}),
		})
		await expect(compilePluxelParaglide(fixture.path)).rejects.toThrow('missing-module.js')
		await expect(stat(resolve(fixture.path, PLUXEL_PARAGLIDE_OUTDIR))).rejects.toMatchObject({
			code: 'ENOENT',
		})
	})

	it.each([false, true])(
		'tree-shakes unused messages in a Rolldown bundle (minify=%s)',
		async (minify) => {
			await using fixture = await createFixture({
				'package.json': packageManifest,
				[PLUXEL_PARAGLIDE_SETTINGS]: settings('./messages/{locale}.json', {
					locales: ['en', 'de'],
				}),
				'messages/en.json': '{"used":"Hello {name}","unused_only":"UNUSED_MESSAGE_EN"}',
				'messages/de.json': '{"used":"Hallo {name}","unused_only":"UNUSED_MESSAGE_DE"}',
				'entry.ts': `import { m, resolveLocale } from '#i18n'
				export const text = (requested?: string) => m.used({ name: 'Plugin' }, { locale: resolveLocale(requested) })`,
			})
			await compilePluxelParaglide(fixture.path)
			const bundle = await rolldown({
				input: resolve(fixture.path, 'entry.ts'),
				platform: 'neutral',
			})
			try {
				const {
					output: [entry],
				} = await bundle.generate({ format: 'esm', minify })
				expect(entry?.code).toContain('Hello')
				expect(entry?.code).toContain('Hallo')
				expect(entry?.code).not.toMatch(/unused_message|unused_?only|node:async_hooks/i)
			} finally {
				await bundle.close()
			}
		},
	)
})
