import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { sourceFiles } from '../src/shared/source-files.js'
import { studioFixture } from './studio-fixture.js'

it('captures read-only PNG bytes with source, copies its figure, and saves only text', async () => {
	await using fixture = await studioFixture('Image source resources')
	const { studio, project } = fixture
	const target = { projectId: project.id, entry: '报表/客户服务报告/客户服务报告.ts' }
	const imagePath = '报表/客户服务报告/pixel.png'
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
		'base64',
	)
	await studio.putAsset({ projectId: project.id, path: imagePath, bytes: png })
	const input = await studio.getInput(target)
	expect(input.assets).toEqual([{ path: imagePath, size: png.length, bytes: png }])
	expect(input.editor!.files).not.toHaveProperty(imagePath)
	const path = '报表/客户服务报告/summary.typ'
	const source = '#figure(image("pixel.png", width: 12pt), caption: [Pixel]) <fig:pixel>'
	const files = sourceFiles(input)
	files[path] = source
	const core = createTypstSourceProject({ files, writablePaths: [path] })
	expect(
		core.copy({
			baseRevision: 0,
			path,
			from: 0,
			to: Buffer.byteLength(source),
			toPath: path,
			at: Buffer.byteLength(source),
		}),
	).toMatchObject({ ok: true })
	const copied = core.open(path).source
	expect(copied).toContain('<fig:pixel-copy>')
	const saved = await studio.setInput({
		...target,
		data: input.data,
		editor: { files: { ...input.editor!.files, [path]: copied } },
		expectedVersion: input.storageVersion,
	})
	expect(saved.assets).toEqual(input.assets)
	expect(await readFile(join(project.root, imagePath))).toEqual(png)
	const compiled = await studio.compile({ ...target, ...saved, clientRevision: 1 })
	expect(compiled.pageCount).toBeGreaterThan(0)
	const reopened = createTypstSourceProject({ files: sourceFiles(await studio.getInput(target)) })
	expect(reopened.snapshot().files[imagePath]).toEqual(new Uint8Array(png))
	expect(reopened.open(path).labels).toHaveLength(2)
}, 120000)
