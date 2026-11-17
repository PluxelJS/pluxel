import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createTypstSourceLibrary } from '../src/source/library.js'
import { loadNativeCompiler } from '../src/native-binding.ts'
import runTypst from '../src/worker.ts'

it('prints the actual application form on one page and paginates long fields without changing its template', async () => {
	const template = new URL('./consumer/public/application-form/main.typ', import.meta.url)
	const source = await readFile(template, 'utf8')
	const initial = JSON.parse(
		await readFile(
			new URL('./consumer/public/application-form/data/application.json', import.meta.url),
			'utf8',
		),
	)
	const family = 'Noto Serif CJK SC'
	const [matched, fontPath] = execFileSync('fc-match', ['-f', '%{family}\n%{file}', family], {
		encoding: 'utf8',
	}).split('\n')
	if (!matched?.split(',').includes(family) || !fontPath)
		throw new Error(`This regression requires ${family}`)
	const root = await mkdtemp(join(tmpdir(), 'typst-application-form-'))
	const bindingPath = fileURLToPath(new URL('../native/compiler.node', import.meta.url))
	const short = {
		...initial,
		name: '张同学',
		studentId: '20260001',
		reason: '申请参加项目研究。',
		opinion: '同意按计划开展。',
		signature: '张同学签字',
		date: '2026-11-02',
	}
	const long = {
		...short,
		reason: Array.from(
			{ length: 110 },
			(_, index) =>
				`申请理由第${index + 1}段：申请参与课题研究并保留完整材料，不应裁切或删去任何内容。`,
		).join('\n'),
		opinion: Array.from(
			{ length: 60 },
			(_, index) =>
				`审批意见第${index + 1}段：请逐项审核申请材料并保留完整记录，不应裁切或删去任何内容。`,
		).join('\n'),
	}
	try {
		const files = { ...(await createTypstSourceLibrary()), 'main.typ': source }
		for (const [path, contents] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), contents)
		}
		await mkdir(join(root, 'data'), { recursive: true })
		const pageCounts: number[] = []
		for (const [index, data] of [short, long].entries()) {
			await writeFile(join(root, 'data/application.json'), JSON.stringify(data))
			const result = runTypst({
				root,
				entry: 'main.typ',
				revision: index + 1,
				bindingPath,
				maxOutputBytes: 8_000_000,
				fontPaths: [fontPath],
			})
			if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
			expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
			pageCounts.push(result.navigation.pages.length)
		}
		expect(pageCounts[0]).toBe(1)
		expect(pageCounts[1]).toBeGreaterThan(1)
		const compiler = loadNativeCompiler(bindingPath).create({
			workspace: root,
			fontArgs: [{ fontPaths: [fontPath] }],
		})
		const document = compiler.compile({ mainFilePath: join(root, 'main.typ') })
		expect(document.result).toBeDefined()
		const rendered = [
			...compiler.svg(document.result!).matchAll(/<h5:div class="tsel"[^>]*>(.*?)<\/h5:div>/g),
		]
			.map((match) => match[1])
			.join('')
			.replaceAll(/\s/g, '')
		for (const key of ['name', 'studentId', 'reason', 'opinion', 'signature', 'date'] as const)
			expect(rendered).toContain(long[key].replaceAll(/\s/g, ''))
		expect(await readFile(join(root, 'main.typ'), 'utf8')).toBe(source)
		expect(await readFile(template, 'utf8')).toBe(source)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
