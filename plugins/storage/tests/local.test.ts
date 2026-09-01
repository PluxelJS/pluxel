import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginConstructor } from '@pluxel/runtime'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { S3, S3NotRunningError, S3Plugin, S3UnsupportedOperationError } from '../src/index.ts'

@Plugin()
class LocalS3Consumer extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

const temporaryRoots: string[] = []

function addStarted(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.start(PluginClass)
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	)
})

describe('S3Plugin local backend', () => {
	it('preserves S3 keys and object metadata across provider lifecycles', async () => {
		const root = await temporaryRoot()
		const keys = ['documents/你好.txt', '../escape', '/absolute//key', 'windows\\key']
		await withLocalS3(root, async (s3) => {
			expect(await s3.bucket().client.bucketExists()).toBe(true)
			expect(await s3.bucket().client.createBucket()).toBe(false)
			for (const key of keys) {
				const response = await s3
					.bucket()
					.client.putObject(key, `body:${key}`, 'text/plain; charset=utf-8', undefined, {
						'x-amz-meta-owner': 'tests',
					})
				expect(response.ok).toBe(true)
				expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/)
			}
			const response = await s3.bucket().client.getObjectResponse('documents/你好.txt')
			expect(response?.headers.get('content-type')).toBe('text/plain; charset=utf-8')
			expect(response?.headers.get('x-amz-meta-owner')).toBe('tests')
			expect(await response?.text()).toBe('body:documents/你好.txt')
		})

		await withLocalS3(root, async (s3) => {
			for (const key of keys) expect(await s3.bucket().client.objectExists(key)).toBe(true)
			const listed = await s3.bucket().client.listObjects('\u0001')
			expect(listed?.map((object) => object.Key).sort()).toEqual([...keys].sort())
			await expect(s3.bucket().client.deleteObject('../escape')).resolves.toBe(true)
			await expect(s3.bucket().client.deleteObject('../escape')).resolves.toBe(true)
		})
	})

	it('matches s3mini listing, ranged-read, copy, move, and batch-delete shapes', async () => {
		const root = await temporaryRoot()
		await withLocalS3(root, async (s3) => {
			for (const key of ['files/a', 'files/deep/b', 'files/deep/c', 'other/z']) {
				await s3.bucket().client.putAnyObject(key, key)
			}

			const grouped = await s3.bucket().client.listObjects('/', 'files/')
			expect(grouped?.map((object) => object.Key)).toEqual(['files/a', 'files/deep/'])

			const first = await s3.bucket().client.listObjectsPaged('\u0001', 'files/', 2)
			expect(first?.objects?.map((object) => object.Key)).toEqual(['files/a', 'files/deep/b'])
			expect(first?.nextContinuationToken).toBeTypeOf('string')
			const second = await s3
				.bucket()
				.client.listObjectsPaged('\u0001', 'files/', 2, first?.nextContinuationToken)
			expect(second?.objects?.map((object) => object.Key)).toEqual(['files/deep/c'])

			const range = await s3.bucket().client.getObjectRaw('files/deep/b', false, 6, 10)
			expect(range.status).toBe(206)
			expect(range.headers.get('content-range')).toBe('bytes 6-9/12')
			expect(await range.text()).toBe('deep')
			const etag = await s3.bucket().client.getEtag('files/a')
			expect(await s3.bucket().client.getObject('files/a', { 'if-match': `"${etag}"` })).toBe(
				'files/a',
			)
			expect(
				await s3.bucket().client.objectExists('files/a', { 'if-none-match': `"${etag}"` }),
			).toBe(null)
			expect(await s3.bucket().client.getObject('missing')).toBe(null)

			const copied = await s3.bucket().client.copyObject('files/a', 'copy/a', {
				metadataDirective: 'REPLACE',
				metadata: { copied: 'yes' },
				contentType: 'text/custom',
			})
			expect(copied.etag).toMatch(/^[a-f0-9]{64}$/)
			const copy = await s3.bucket().client.getObjectResponse('copy/a')
			expect(copy?.headers.get('x-amz-meta-copied')).toBe('yes')
			expect(copy?.headers.get('content-type')).toBe('text/custom')

			await s3.bucket().client.moveObject('copy/a', 'moved/a')
			expect(await s3.bucket().client.objectExists('copy/a')).toBe(false)
			expect(await s3.bucket().client.objectExists('moved/a')).toBe(true)
			expect(await s3.bucket().client.deleteObjects(['moved/a', 'other/z'])).toEqual([true, true])
		})
	})

	it('does not publish a streamed object whose declared length is wrong', async () => {
		const root = await temporaryRoot()
		await withLocalS3(root, async (s3) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2]))
					controller.close()
				},
			})
			await expect(
				s3
					.bucket()
					.client.putObject(
						'broken.bin',
						body,
						'application/octet-stream',
						undefined,
						undefined,
						3,
					),
			).rejects.toThrow(/produced 2 bytes/i)
			expect(await s3.bucket().client.objectExists('broken.bin')).toBe(false)
		})
	})

	it('supports explicit multipart uploads and reports unsupported S3 semantics honestly', async () => {
		const root = await temporaryRoot()
		await withLocalS3(root, async (s3) => {
			const uploadId = await s3
				.bucket()
				.client.getMultipartUploadId('large.bin', 'application/octet-stream')
			const one = await s3
				.bucket()
				.client.uploadPart('large.bin', uploadId, new Uint8Array([1, 2]), 1)
			const two = await s3
				.bucket()
				.client.uploadPart('large.bin', uploadId, new Uint8Array([3, 4]), 2)
			const uploads = await s3.bucket().client.listMultipartUploads()
			expect(uploads).toMatchObject({
				listMultipartUploadsResult: {
					bucket: 'test-bucket',
					key: 'large.bin',
					uploadId,
					isTruncated: false,
				},
			})
			const complete = await s3
				.bucket()
				.client.completeMultipartUpload('large.bin', uploadId, [one, two])
			expect(complete).toMatchObject({
				location: 'local-s3:///test-bucket/large.bin',
				bucket: 'test-bucket',
				key: 'large.bin',
			})
			expect(new Uint8Array((await s3.bucket().client.getObjectArrayBuffer('large.bin'))!)).toEqual(
				new Uint8Array([1, 2, 3, 4]),
			)
			const abortedId = await s3.bucket().client.getMultipartUploadId('aborted.bin')
			await expect(
				s3.bucket().client.abortMultipartUpload('aborted.bin', abortedId),
			).resolves.toMatchObject({
				status: 'Aborted',
				key: 'aborted.bin',
				uploadId: abortedId,
			})

			await expect(s3.bucket().client.getPresignedUrl('GET', 'large.bin')).rejects.toMatchObject({
				name: S3UnsupportedOperationError.name,
				code: 'S3_UNSUPPORTED_OPERATION',
			})
			await expect(s3.bucket().client.setBucketVersioning('Enabled')).rejects.toBeInstanceOf(
				S3UnsupportedOperationError,
			)
			await expect(
				s3.bucket().client.getObject(
					'large.bin',
					{},
					{
						'x-amz-server-side-encryption-customer-algorithm': 'AES256',
						'x-amz-server-side-encryption-customer-key': 'secret',
						'x-amz-server-side-encryption-customer-key-md5': 'digest',
					},
				),
			).rejects.toBeInstanceOf(S3UnsupportedOperationError)
		})
	})

	it('revokes the caller facade and captured local client on provider stop', async () => {
		const root = await temporaryRoot()
		await withRuntimeHost(async (host) => {
			addStarted(host, [S3Plugin, LocalS3Consumer])
			host.cfg(S3Plugin).set({
				buckets: [
					{
						id: 'default',
						backend: {
							type: 'local',
							rootDir: root,
							bucketName: 'test-bucket',
							syncWrites: false,
						},
					},
				],
			})
			await host.commit()
			const capability = host.require(LocalS3Consumer).s3
			const bucket = capability.bucket()
			const client = bucket.client
			host.stop(S3Plugin)
			await host.commit()
			expect(() => bucket.client).toThrow('Plugin owner stopped')
			await expect(client.bucketExists()).rejects.toBeInstanceOf(S3NotRunningError)
		})
	})
})

async function temporaryRoot(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'pluxel-s3-'))
	temporaryRoots.push(path)
	return path
}

async function withLocalS3(rootDir: string, run: (s3: S3) => void | Promise<void>): Promise<void> {
	await withRuntimeHost(async (host) => {
		addStarted(host, [S3Plugin, LocalS3Consumer])
		host.cfg(S3Plugin).set({
			buckets: [
				{
					id: 'default',
					backend: {
						type: 'local',
						rootDir,
						bucketName: 'test-bucket',
						syncWrites: false,
					},
				},
			],
		})
		await host.commit()
		await run(host.require(LocalS3Consumer).s3)
	})
}
