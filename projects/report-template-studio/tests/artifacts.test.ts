import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore, ARTIFACT_POLICY } from '../src/backend/artifacts.js'
import type { PageArtifact, PdfArtifact } from '../src/shared/contracts.js'
const roots: string[] = []
afterEach(async () => {
	vi.useRealTimers()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function makeRoot() {
	const path = await mkdtemp(join(tmpdir(), 'studio-artifacts-'))
	roots.push(path)
	return path
}
const metadata = {
	projectId: 'project',
	entry: 'report/report.ts',
	revision: 'revision',
	kind: 'pdf' as const,
	mimeType: 'application/pdf' as const,
}

it('publishes complete immutable files and recovers metadata/content together after normal restart', async () => {
	const path = await makeRoot()
	const store = new ArtifactStore(path)
	const bytes = Buffer.from('%PDF-evidence')
	const first = await store.publish<PdfArtifact>(metadata, bytes)
	const second = await store.publish<PdfArtifact>(metadata, Buffer.from('%PDF-other'))
	expect(first.path).not.toBe(second.path)
	expect(await readFile(first.path)).toEqual(bytes)
	expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBeGreaterThanOrEqual(
		24 * 60 * 60 * 1000,
	)
	await store.close()
	const reopened = new ArtifactStore(path)
	await reopened.initialize()
	expect(await reopened.resolve(first.id)).toEqual(first)
	expect(await reopened.read(first.id)).toEqual(bytes)
	await reopened.close()
})
it('keeps retained page metadata independent from direct consumer mutation', async () => {
	const store = new ArtifactStore(await makeRoot())
	const page = {
		...metadata,
		kind: 'png' as const,
		mimeType: 'image/png' as const,
		page: 1,
		width: 100,
		height: 80,
		region: { x: 0, y: 0, width: 100, height: 80 },
		headings: [{ title: 'Retained', level: 1, page: 1, x: 0, y: 0 }],
		sources: [{ path: 'report/layout.typ', fromLine: 1, toLine: 2 }],
	}
	const artifact = await store.publish<PageArtifact>(page, Buffer.from('page bytes'))
	Reflect.set(artifact.region, 'width', 1)
	Reflect.set(artifact.headings[0]!, 'title', 'Consumer edit')
	page.sources[0]!.path = 'elsewhere'
	const retained = (await store.resolve(artifact.id)) as PageArtifact
	expect(retained.region.width).toBe(100)
	expect(retained.headings[0]!.title).toBe('Retained')
	expect(retained.sources[0]!.path).toBe('report/layout.typ')
	Reflect.set(retained.region, 'width', 2)
	expect(((await store.resolve(artifact.id)) as PageArtifact).region.width).toBe(100)
	await store.close()
})
it('reserves concurrent bytes and file slots, refuses quota without early cleanup, and releases failed reservations', async () => {
	const path = await makeRoot()
	const store = new ArtifactStore(path, { ...ARTIFACT_POLICY, maxBytes: 6, maxFiles: 2 })
	let release!: () => void
	const gate = new Promise<void>((resolve) => (release = resolve))
	let entered = 0
	const waiting = async () => {
		entered++
		await gate
	}
	const first = store.publish<PdfArtifact>(metadata, Buffer.from('abc'), waiting)
	const second = store.publish<PdfArtifact>(metadata, Buffer.from('def'), waiting)
	await vi.waitFor(() => expect(entered).toBe(2))
	await expect(store.publish<PdfArtifact>(metadata, Buffer.from('g'))).rejects.toMatchObject({
		code: 'LIMIT_EXCEEDED',
	})
	release()
	const artifacts = await Promise.all([first, second])
	for (const artifact of artifacts) expect(await readFile(artifact.path)).toHaveLength(3)
	await expect(store.publish<PdfArtifact>(metadata, Buffer.from('ghi'))).rejects.toMatchObject({
		code: 'LIMIT_EXCEEDED',
	})
	vi.setSystemTime(Date.now() + ARTIFACT_POLICY.retentionMs + 1)
	const after = await store.publish<PdfArtifact>(metadata, Buffer.from('ghi'))
	expect(await readFile(after.path)).toEqual(Buffer.from('ghi'))
	for (const artifact of artifacts)
		await expect(readFile(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
	await store.close()
})
it('rejects source changes before publication and returns no partial file reference', async () => {
	const path = await makeRoot()
	const store = new ArtifactStore(path, { ...ARTIFACT_POLICY, maxFiles: 1 })
	await expect(
		store.publish<PdfArtifact>(metadata, Buffer.from('partial'), async () => {
			throw Object.assign(new Error('Source changed'), { code: 'REVISION_CONFLICT' })
		}),
	).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
	expect(await readdir(path)).toEqual([])
	const next = await store.publish<PdfArtifact>(metadata, Buffer.from('whole'))
	expect(await readFile(next.path)).toEqual(Buffer.from('whole'))
	await store.close()
})
it('preserves foreign files inserted into an unfinished publication and retains both failure causes', async () => {
	const path = await makeRoot()
	const store = new ArtifactStore(path)
	let foreign = ''
	await expect(
		store.publish<PdfArtifact>(metadata, Buffer.from('unfinished'), async () => {
			const names = await readdir(path)
			foreign = join(
				path,
				names.find((name) => name.startsWith('.pending-'))!,
				'user-note.txt',
			)
			await writeFile(foreign, 'user data')
			throw Object.assign(new Error('Source changed'), { code: 'REVISION_CONFLICT' })
		}),
	).rejects.toMatchObject({
		code: 'REVISION_CONFLICT',
		cause: { message: 'Source changed' },
		errors: expect.arrayContaining([expect.objectContaining({ code: 'IO_ERROR' })]),
	})
	expect(await readFile(foreign, 'utf8')).toBe('user data')
	await store.close()
	const restarted = new ArtifactStore(path)
	await restarted.initialize()
	expect(await readFile(foreign, 'utf8')).toBe('user data')
	await restarted.close()
})
it('startup cleanup touches only owned expired/unfinished directories and never follows links', async () => {
	const path = await makeRoot()
	const store = new ArtifactStore(path)
	const published = await store.publish<PdfArtifact>(metadata, Buffer.from('retained'))
	await store.close()
	const foreign = join(path, randomUUID())
	await mkdir(foreign)
	await writeFile(join(foreign, 'keep.txt'), 'user data')
	const temporaryId = randomUUID(),
		pending = join(path, '.pending-' + temporaryId)
	await mkdir(pending)
	await writeFile(
		join(pending, '.studio-artifact'),
		'report-template-studio-artifact-v1\n' + temporaryId,
	)
	await writeFile(join(pending, 'document.pdf'), 'incomplete')
	if (process.platform !== 'win32') await symlink(foreign, join(path, randomUUID()))
	const reopened = new ArtifactStore(path)
	await reopened.initialize()
	expect(await readFile(join(foreign, 'keep.txt'), 'utf8')).toBe('user data')
	expect(await readFile(published.path, 'utf8')).toBe('retained')
	await expect(readdir(pending)).rejects.toMatchObject({ code: 'ENOENT' })
	await reopened.close()
})
