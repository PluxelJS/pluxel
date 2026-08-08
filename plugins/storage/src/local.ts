import { createHash, randomUUID } from 'node:crypto'
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	stat,
	unlink,
	writeFile,
	type FileHandle,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import {
	sanitizeETag,
	type CompleteMultipartUploadResult,
	type CopyObjectOptions,
	type CopyObjectResult,
	type DeleteObject,
	type DeleteObjectResult,
	type ListMultipartUploadResponse,
	type ListObject,
	type UploadPart,
} from 's3mini'
import { type S3Client, S3NotRunningError, S3UnsupportedOperationError } from './capability.ts'

const FORMAT_VERSION = 1
const FORMAT_ROOT = 'v1'
const OBJECT_FILE = '.object'
const MANIFEST_FILE = 'manifest.json'
const FOOTER_MAGIC = Buffer.from('PLUXS301', 'ascii')
const FOOTER_BYTES = 4 + FOOTER_MAGIC.byteLength
const MAX_HEADER_BYTES = 64 * 1_024
const MAX_KEY_BYTES = 1_024
const PATH_CHUNK_LENGTH = 100
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'
const DEFAULT_REQUEST_SIZE = 8 * 1024 * 1024
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

type PutData = Parameters<S3Client['putObject']>[1]
type AnyData = Parameters<S3Client['putAnyObject']>[1]
type SSECHeaders = Parameters<S3Client['putObject']>[3]
type AWSHeaders = Parameters<S3Client['putObject']>[4]

type LocalHeader = {
	version: 1
	key: string
	size: number
	contentType: string
	etag: string
	lastModifiedMs: number
	headers: Record<string, string>
}

type OpenLocalObject = {
	file: FileHandle
	header: LocalHeader
}

type MultipartManifest = {
	version: 1
	uploadId: string
	key: string
	contentType: string
	headers: Record<string, string>
	createdAtMs: number
}

type LocalS3ClientOptions = {
	rootDir: string
	bucketName: string
	syncWrites: boolean
}

export class LocalS3Client implements S3Client {
	readonly endpoint: URL
	readonly region = 'local'
	readonly bucketName: string
	readonly requestSizeInBytes = DEFAULT_REQUEST_SIZE
	readonly requestAbortTimeout: number | undefined = undefined
	readonly logger: undefined = undefined
	readonly minPartSize = DEFAULT_REQUEST_SIZE

	private readonly bucketRoot: string
	private readonly objectsRoot: string
	private readonly multipartRoot: string
	private readonly syncWrites: boolean
	private readonly controller = new AbortController()
	private readonly inFlight = new Set<Promise<unknown>>()

	constructor(options: LocalS3ClientOptions) {
		this.bucketName = options.bucketName
		this.endpoint = new URL(`local-s3:///${encodeURIComponent(options.bucketName)}`)
		this.bucketRoot = join(
			options.rootDir,
			'buckets',
			...encodePathComponents(options.bucketName),
			FORMAT_ROOT,
		)
		this.objectsRoot = join(this.bucketRoot, 'objects')
		this.multipartRoot = join(this.bucketRoot, '.multipart')
		this.syncWrites = options.syncWrites
	}

	sanitizeETag(etag: string): string {
		return sanitizeETag(etag)
	}

	createBucket(): Promise<boolean> {
		return this.run(async () => {
			const exists = await isDirectory(this.bucketRoot)
			await mkdir(this.objectsRoot, { recursive: true })
			await mkdir(this.multipartRoot, { recursive: true })
			return !exists
		})
	}

	bucketExists(): Promise<boolean> {
		return this.run(async () => isDirectory(this.bucketRoot))
	}

	setBucketVersioning(status: 'Enabled' | 'Suspended'): Promise<boolean> {
		return this.run(async () => {
			if (status !== 'Enabled' && status !== 'Suspended') {
				throw new TypeError("[s3mini] status must be 'Enabled' or 'Suspended'")
			}
			throw new S3UnsupportedOperationError('bucket versioning')
		})
	}

	getBucketVersioning(): Promise<'Enabled' | 'Suspended' | 'Off'> {
		return this.run(async () => 'Off' as const)
	}

	listObjects(
		delimiter = '/',
		prefix = '',
		maxKeys?: number,
		opts: Record<string, unknown> = {},
	): Promise<ListObject[] | null> {
		return this.run(async () => {
			const results = await this.listCandidates(delimiter, prefix, opts)
			if (results === null) return null
			const limit = maxKeys === undefined || maxKeys <= 0 ? results.length : validMaxKeys(maxKeys)
			return results.slice(0, limit)
		})
	}

	listObjectsPaged(
		delimiter = '/',
		prefix = '',
		maxKeys = 100,
		nextContinuationToken?: string,
		opts: Record<string, unknown> = {},
	): Promise<{ objects: ListObject[] | null; nextContinuationToken?: string } | null> {
		return this.run(async () => {
			const limit = validMaxKeys(maxKeys)
			const results = await this.listCandidates(delimiter, prefix, opts)
			if (results === null) return null
			const after = nextContinuationToken
				? decodeContinuationToken(nextContinuationToken, delimiter, prefix)
				: undefined
			const remaining = after ? results.filter((item) => compareUtf8(item.Key, after) > 0) : results
			const objects = remaining.slice(0, limit)
			const hasMore = remaining.length > objects.length
			return {
				objects,
				nextContinuationToken:
					hasMore && objects.length > 0
						? encodeContinuationToken(delimiter, prefix, objects.at(-1)!.Key)
						: undefined,
			}
		})
	}

	listObjectVersions(key: string, _maxKeys?: number): Promise<ListObject[] | null> {
		return this.run(async () => {
			validateKey(key)
			throw new S3UnsupportedOperationError('object version listing')
		})
	}

	listMultipartUploads(
		delimiter = '/',
		prefix = '',
		method: 'POST' | 'GET' | 'HEAD' | 'PUT' | 'DELETE' = 'GET',
		opts: Record<string, string | number | boolean | undefined> = {},
	): Promise<ListMultipartUploadResponse> {
		return this.run(async () => {
			validateDelimiter(delimiter)
			validatePrefix(prefix)
			if (method !== 'GET' && method !== 'HEAD') {
				throw new Error('[s3mini] method must be either GET or HEAD')
			}
			assertEmptyOptions(opts, 'multipart upload listing options')
			const available = await this.readMultipartManifests()
			const manifests = available
				.filter((manifest) => manifest.key.startsWith(prefix))
				.sort((left, right) => compareUtf8(left.key, right.key))
			const uploads = manifests.map((manifest) => ({
				key: manifest.key,
				uploadId: manifest.uploadId,
				initiated: new Date(manifest.createdAtMs),
			}))
			return {
				listMultipartUploadsResult: {
					bucket: this.bucketName,
					key: uploads[0]?.key ?? '',
					uploadId: uploads[0]?.uploadId ?? '',
					parts: [] as UploadPart[],
					isTruncated: false,
					// s3mini 1.0 types S3 upload descriptors as UploadPart[] even though the
					// wire response carries key/uploadId/initiated fields.
					uploads: uploads as unknown as UploadPart[],
				},
			}
		})
	}

	getObject(
		key: string,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<string | null> {
		return this.run(async () => {
			const response = await this.getObjectResponseInternal(key, opts, ssecHeaders)
			return response ? response.text() : null
		})
	}

	getObjectResponse(
		key: string,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<Response | null> {
		return this.run(() => this.getObjectResponseInternal(key, opts, ssecHeaders))
	}

	getObjectArrayBuffer(
		key: string,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<ArrayBuffer | null> {
		return this.run(async () => {
			const response = await this.getObjectResponseInternal(key, opts, ssecHeaders)
			return response ? response.arrayBuffer() : null
		})
	}

	getObjectJSON<T = unknown>(
		key: string,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<T | null> {
		return this.run(async () => {
			const response = await this.getObjectResponseInternal(key, opts, ssecHeaders)
			return response ? (response.json() as Promise<T>) : null
		})
	}

	getObjectWithETag(
		key: string,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<{ etag: string | null; data: ArrayBuffer | null }> {
		return this.run(async () => {
			const response = await this.getObjectResponseInternal(key, opts, ssecHeaders)
			if (!response) return { etag: null, data: null }
			return {
				etag: sanitizeETag(response.headers.get('etag') ?? ''),
				data: await response.arrayBuffer(),
			}
		})
	}

	getObjectRaw(
		key: string,
		wholeFile = true,
		rangeFrom = 0,
		rangeTo?: number,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<Response> {
		return this.run(async () => {
			validateKey(key)
			assertNoSSEC(ssecHeaders, 'SSE-C reads')
			const opened = await openLocalObject(this.objectPath(key))
			if (!opened) throw new Error(`[s3mini] Object not found: ${key}`)
			try {
				const condition = evaluateConditions(opened.header, opts)
				if ('status' in condition) throw new Error(`[s3mini] S3 returned ${condition.status}`)
				if (wholeFile) return objectResponse(opened, this.controller.signal)
				const start = validRangeValue(rangeFrom, 'rangeFrom')
				const end = rangeTo === undefined ? opened.header.size : validRangeValue(rangeTo, 'rangeTo')
				if (start >= end || start >= opened.header.size) {
					throw new RangeError('Requested S3 byte range is not satisfiable.')
				}
				return objectResponse(
					opened,
					this.controller.signal,
					start,
					Math.min(end, opened.header.size),
					true,
				)
			} catch (error) {
				await opened.file.close().catch((): undefined => undefined)
				throw error
			}
		})
	}

	getContentLength(key: string, ssecHeaders?: SSECHeaders): Promise<number> {
		return this.run(async () => {
			validateKey(key)
			assertNoSSEC(ssecHeaders, 'SSE-C reads')
			const opened = await openLocalObject(this.objectPath(key))
			if (!opened) throw new Error(`[s3mini] Error getting content length for object ${key}`)
			await opened.file.close()
			return opened.header.size
		})
	}

	objectExists(key: string, opts: Record<string, unknown> = {}): Promise<false | true | null> {
		return this.run(async () => {
			validateKey(key)
			const opened = await openLocalObject(this.objectPath(key))
			if (!opened) return false
			await opened.file.close()
			return evaluateConditions(opened.header, opts).ok ? true : null
		})
	}

	getEtag(
		key: string,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
	): Promise<string | null> {
		return this.run(async () => {
			validateKey(key)
			assertNoSSEC(ssecHeaders, 'SSE-C reads')
			const opened = await openLocalObject(this.objectPath(key))
			if (!opened) return null
			await opened.file.close()
			return evaluateConditions(opened.header, opts).ok ? opened.header.etag : null
		})
	}

	putObject(
		key: string,
		data: PutData,
		fileType = DEFAULT_CONTENT_TYPE,
		ssecHeaders?: SSECHeaders,
		additionalHeaders?: AWSHeaders,
		contentLength?: number,
	): Promise<Response> {
		return this.run(() =>
			this.putObjectInternal(key, data, fileType, ssecHeaders, additionalHeaders, contentLength),
		)
	}

	putAnyObject(
		key: string,
		data: AnyData,
		fileType = DEFAULT_CONTENT_TYPE,
		ssecHeaders?: SSECHeaders,
		additionalHeaders?: AWSHeaders,
		contentLength?: number,
	): Promise<Response> {
		return this.run(() =>
			this.putObjectInternal(key, data, fileType, ssecHeaders, additionalHeaders, contentLength),
		)
	}

	getMultipartUploadId(
		key: string,
		fileType = DEFAULT_CONTENT_TYPE,
		ssecHeaders?: SSECHeaders,
		additionalHeaders?: AWSHeaders,
	): Promise<string> {
		return this.run(async () => {
			validateKey(key)
			validateContentType(fileType)
			assertNoSSEC(ssecHeaders, 'SSE-C multipart uploads')
			const uploadId = randomUUID()
			const directory = this.multipartPath(uploadId)
			await mkdir(directory, { recursive: false })
			const manifest: MultipartManifest = {
				version: FORMAT_VERSION,
				uploadId,
				key,
				contentType: fileType,
				headers: normalizeAdditionalHeaders(additionalHeaders),
				createdAtMs: Date.now(),
			}
			await writeFile(join(directory, MANIFEST_FILE), JSON.stringify(manifest), {
				encoding: 'utf8',
				flag: 'wx',
				mode: 0o600,
			})
			return uploadId
		})
	}

	uploadPart(
		key: string,
		uploadId: string,
		data: AnyData,
		partNumber: number,
		opts: Record<string, unknown> = {},
		ssecHeaders?: SSECHeaders,
		additionalHeaders?: AWSHeaders,
	): Promise<UploadPart> {
		return this.run(async () => {
			validateKey(key)
			validateUploadId(uploadId)
			if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
				throw new TypeError('[s3mini] partNumber must be an integer from 1 to 10000')
			}
			assertEmptyOptions(opts, 'multipart part options')
			assertNoSSEC(ssecHeaders, 'SSE-C multipart uploads')
			assertEmptyOptions(additionalHeaders ?? {}, 'multipart part additional headers')
			const manifest = await this.readMultipartManifest(uploadId)
			if (manifest.key !== key) throw new TypeError('Multipart upload ID belongs to another key.')
			const target = this.partPath(uploadId, partNumber)
			const temporary = `${target}.${randomUUID()}.tmp`
			let file: FileHandle | undefined
			try {
				file = await open(temporary, 'wx', 0o600)
				const result = await writeBody(file, data, this.controller.signal)
				if (this.syncWrites) await file.sync()
				await file.close()
				file = undefined
				await rename(temporary, target)
				return { partNumber, etag: result.etag }
			} catch (error) {
				await file?.close().catch((): undefined => undefined)
				await unlink(temporary).catch((): undefined => undefined)
				throw error
			}
		})
	}

	completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: UploadPart[],
	): Promise<CompleteMultipartUploadResult> {
		return this.run(async () => {
			validateKey(key)
			validateUploadId(uploadId)
			if (!Array.isArray(parts) || parts.length === 0) {
				throw new TypeError('[s3mini] parts must be a non-empty array')
			}
			const manifest = await this.readMultipartManifest(uploadId)
			if (manifest.key !== key) throw new TypeError('Multipart upload ID belongs to another key.')
			let previous = 0
			let contentLength = 0
			for (const part of parts) {
				if (
					!part ||
					!Number.isInteger(part.partNumber) ||
					part.partNumber <= previous ||
					typeof part.etag !== 'string'
				) {
					throw new TypeError('[s3mini] Each part must be ordered and have a partNumber and ETag')
				}
				previous = part.partNumber
				const path = this.partPath(uploadId, part.partNumber)
				const info = await stat(path)
				if (!info.isFile()) throw new Error(`Multipart part ${part.partNumber} is unavailable.`)
				contentLength += info.size
				const actual = await hashFile(path)
				if (sanitizeETag(part.etag) !== actual) {
					throw new Error(`Multipart part ${part.partNumber} ETag does not match.`)
				}
			}

			const body = multipartBody(
				parts.map((part) => this.partPath(uploadId, part.partNumber)),
				this.controller.signal,
			)
			const response = await this.putObjectInternal(
				key,
				body,
				manifest.contentType,
				undefined,
				manifest.headers as AWSHeaders,
				contentLength,
			)
			await rm(this.multipartPath(uploadId), { recursive: true, force: true })
			const etag = sanitizeETag(response.headers.get('etag') ?? '')
			const location = `${this.endpoint.toString().replace(/\/$/, '')}/${encodeS3Key(key)}`
			return { location, bucket: this.bucketName, key, etag, eTag: etag, ETag: etag }
		})
	}

	abortMultipartUpload(key: string, uploadId: string, ssecHeaders?: SSECHeaders): Promise<object> {
		return this.run(async () => {
			validateKey(key)
			validateUploadId(uploadId)
			assertNoSSEC(ssecHeaders, 'SSE-C multipart uploads')
			const manifest = await this.readMultipartManifest(uploadId)
			if (manifest.key !== key) throw new TypeError('Multipart upload ID belongs to another key.')
			await rm(this.multipartPath(uploadId), { recursive: true, force: true })
			return { status: 'Aborted', key, uploadId, response: {} }
		})
	}

	copyObject(
		sourceKey: string,
		destinationKey: string,
		options: CopyObjectOptions = {},
	): Promise<CopyObjectResult> {
		return this.run(async () => {
			validateKey(sourceKey)
			validateKey(destinationKey)
			if (options.versionId) throw new S3UnsupportedOperationError('versioned object copy')
			assertNoSSEC(options.sourceSSECHeaders, 'SSE-C object copy')
			assertNoSSEC(options.destinationSSECHeaders, 'SSE-C object copy')
			if (options.taggingDirective === 'REPLACE') {
				throw new S3UnsupportedOperationError('replacement object tagging')
			}
			const source = await openLocalObject(this.objectPath(sourceKey))
			if (!source) throw new Error(`[s3mini] Object not found: ${sourceKey}`)
			try {
				const headers = { ...source.header.headers }
				let contentType = source.header.contentType
				if (options.metadataDirective === 'REPLACE') {
					for (const name of Object.keys(headers)) {
						if (name.startsWith('x-amz-meta-')) delete headers[name]
					}
					Object.assign(headers, metadataHeaders(options.metadata))
					contentType = options.contentType ?? DEFAULT_CONTENT_TYPE
				} else if (options.metadata || options.contentType) {
					throw new TypeError('copyObject metadata/contentType requires metadataDirective REPLACE.')
				}
				if (options.storageClass)
					headers['x-amz-storage-class'] = validHeaderValue(options.storageClass)
				if (options.websiteRedirectLocation) {
					headers['x-amz-website-redirect-location'] = validHeaderValue(
						options.websiteRedirectLocation,
					)
				}
				Object.assign(headers, normalizeAdditionalHeaders(options.additionalHeaders))
				const body = bodyFromOpenObject(source, this.controller.signal)
				const response = await this.putObjectInternal(
					destinationKey,
					body,
					contentType,
					undefined,
					headers as AWSHeaders,
					source.header.size,
				)
				return {
					etag: sanitizeETag(response.headers.get('etag') ?? ''),
					lastModified: new Date(),
				}
			} catch (error) {
				await source.file.close().catch((): undefined => undefined)
				throw error
			}
		})
	}

	moveObject(
		sourceKey: string,
		destinationKey: string,
		options: CopyObjectOptions = {},
	): Promise<CopyObjectResult> {
		return this.run(async () => {
			const result = await this.copyObject(sourceKey, destinationKey, options)
			await this.deleteObject(sourceKey)
			return result
		})
	}

	deleteObject(target: string | DeleteObject): Promise<boolean>
	deleteObject(
		target: string | DeleteObject,
		options: { versionInfo: true },
	): Promise<DeleteObjectResult>
	deleteObject(
		target: string | DeleteObject,
		options: { versionInfo?: boolean } = {},
	): Promise<boolean | DeleteObjectResult> {
		return this.run(async () => {
			const normalized = normalizeDeleteTarget(target)
			if (normalized.versionId) {
				throw new S3UnsupportedOperationError('versioned object deletion')
			}
			await this.deleteKey(normalized.key)
			return options.versionInfo ? { key: normalized.key, deleted: true } : true
		})
	}

	deleteObjects(targets: Array<string | DeleteObject>): Promise<boolean[]>
	deleteObjects(
		targets: Array<string | DeleteObject>,
		options: { versionInfo: true },
	): Promise<DeleteObjectResult[]>
	deleteObjects(
		targets: Array<string | DeleteObject>,
		options: { versionInfo?: boolean } = {},
	): Promise<boolean[] | DeleteObjectResult[]> {
		return this.run(async () => {
			if (!Array.isArray(targets)) throw new TypeError('deleteObjects targets must be an array.')
			const normalized = targets.map(normalizeDeleteTarget)
			if (normalized.some((target) => target.versionId)) {
				throw new S3UnsupportedOperationError('versioned object deletion')
			}
			for (const target of normalized) await this.deleteKey(target.key)
			return options.versionInfo
				? normalized.map((target) => ({ key: target.key, deleted: true }))
				: normalized.map(() => true)
		})
	}

	getPresignedUrl(
		_method: 'GET' | 'PUT',
		_key: string,
		_expiresIn?: number,
		_queryParams?: Record<string, string>,
		_headers?: Record<string, string>,
	): Promise<string> {
		return this.run(async () => {
			throw new S3UnsupportedOperationError('pre-signed URLs')
		})
	}

	async dispose(): Promise<void> {
		if (!this.controller.signal.aborted) this.controller.abort(new S3NotRunningError())
		await Promise.allSettled(this.inFlight)
	}

	private async run<T>(operation: () => Promise<T>): Promise<T> {
		this.controller.signal.throwIfAborted()
		const pending = Promise.resolve().then(operation)
		this.inFlight.add(pending)
		try {
			const result = await pending
			this.controller.signal.throwIfAborted()
			return result
		} finally {
			this.inFlight.delete(pending)
		}
	}

	private async putObjectInternal(
		key: string,
		data: PutData,
		fileType: string,
		ssecHeaders?: SSECHeaders,
		additionalHeaders?: AWSHeaders,
		contentLength?: number,
	): Promise<Response> {
		validateKey(key)
		validateContentType(fileType)
		assertNoSSEC(ssecHeaders, 'SSE-C object writes')
		if (
			contentLength !== undefined &&
			(!Number.isSafeInteger(contentLength) || contentLength < 0)
		) {
			throw new RangeError('contentLength must be a non-negative safe integer.')
		}
		await mkdir(this.objectsRoot, { recursive: true })
		const target = this.objectPath(key)
		const directory = dirname(target)
		await mkdir(directory, { recursive: true })
		const temporary = join(directory, `.${process.pid}-${randomUUID()}.tmp`)
		let file: FileHandle | undefined
		try {
			file = await open(temporary, 'wx', 0o600)
			const { size, etag } = await writeBody(file, data, this.controller.signal)
			if (contentLength !== undefined && contentLength !== size) {
				throw new RangeError(
					`Object stream produced ${size} bytes; contentLength declared ${contentLength}.`,
				)
			}
			const header: LocalHeader = {
				version: FORMAT_VERSION,
				key,
				size,
				contentType: fileType,
				etag,
				lastModifiedMs: Date.now(),
				headers: normalizeAdditionalHeaders(additionalHeaders),
			}
			await appendHeader(file, header)
			if (this.syncWrites) await file.sync()
			await file.close()
			file = undefined
			this.controller.signal.throwIfAborted()
			await rename(temporary, target)
			if (this.syncWrites) await syncDirectory(directory)
			return new Response(null, { status: 200, headers: { etag: quoteETag(etag) } })
		} catch (error) {
			await file?.close().catch((): undefined => undefined)
			await unlink(temporary).catch((): undefined => undefined)
			throw error
		}
	}

	private async getObjectResponseInternal(
		key: string,
		opts: Record<string, unknown>,
		ssecHeaders?: SSECHeaders,
	): Promise<Response | null> {
		validateKey(key)
		assertNoSSEC(ssecHeaders, 'SSE-C reads')
		const opened = await openLocalObject(this.objectPath(key))
		if (!opened) return null
		try {
			if (!evaluateConditions(opened.header, opts).ok) {
				await opened.file.close()
				return null
			}
			return objectResponse(opened, this.controller.signal)
		} catch (error) {
			await opened.file.close().catch((): undefined => undefined)
			throw error
		}
	}

	private async listCandidates(
		delimiter: string,
		prefix: string,
		opts: Record<string, unknown>,
	): Promise<ListObject[] | null> {
		validateDelimiter(delimiter)
		validatePrefix(prefix)
		if (opts.versions === true) throw new S3UnsupportedOperationError('object version listing')
		assertEmptyOptions(opts, 'object listing options')
		if (!(await isDirectory(this.objectsRoot))) return null
		const objects: ListObject[] = []
		const commonPrefixes = new Set<string>()
		for await (const path of walkObjectFiles(this.objectsRoot, this.controller.signal)) {
			const opened = await openLocalObject(path)
			if (!opened) continue
			await opened.file.close()
			const header = opened.header
			if (!header.key.startsWith(prefix)) continue
			const suffix = header.key.slice(prefix.length)
			const delimiterIndex = suffix.indexOf(delimiter)
			if (delimiterIndex >= 0) {
				commonPrefixes.add(prefix + suffix.slice(0, delimiterIndex + delimiter.length))
				continue
			}
			objects.push(toListObject(header))
		}
		for (const key of commonPrefixes) {
			objects.push({
				Key: key,
				Size: 0,
				LastModified: new Date(0),
				ETag: '',
				StorageClass: '',
			})
		}
		objects.sort((left, right) => compareUtf8(left.Key, right.Key))
		return objects
	}

	private objectPath(key: string): string {
		return join(this.objectsRoot, ...encodePathComponents(key), OBJECT_FILE)
	}

	private multipartPath(uploadId: string): string {
		return join(this.multipartRoot, uploadId)
	}

	private partPath(uploadId: string, partNumber: number): string {
		return join(this.multipartPath(uploadId), `part-${String(partNumber).padStart(5, '0')}`)
	}

	private async readMultipartManifest(uploadId: string): Promise<MultipartManifest> {
		let raw: string
		try {
			raw = await readFile(join(this.multipartPath(uploadId), MANIFEST_FILE), 'utf8')
		} catch (error) {
			if (errno(error) === 'ENOENT') {
				throw new Error(`[s3mini] No such upload: ${uploadId}`, { cause: error })
			}
			throw error
		}
		return parseMultipartManifest(raw, uploadId)
	}

	private async readMultipartManifests(): Promise<MultipartManifest[]> {
		let entries
		try {
			entries = await readdir(this.multipartRoot, { withFileTypes: true })
		} catch (error) {
			if (errno(error) === 'ENOENT') return []
			throw error
		}
		const manifests: MultipartManifest[] = []
		for (const entry of entries) {
			if (!entry.isDirectory() || !isUploadId(entry.name)) continue
			try {
				manifests.push(await this.readMultipartManifest(entry.name))
			} catch (error) {
				if (errno(error) !== 'ENOENT') throw error
			}
		}
		return manifests
	}

	private async deleteKey(key: string): Promise<void> {
		validateKey(key)
		const target = this.objectPath(key)
		try {
			await unlink(target)
		} catch (error) {
			if (errno(error) === 'ENOENT') return
			throw error
		}
		if (this.syncWrites) await syncDirectory(dirname(target))
		await pruneEmptyDirectories(dirname(target), this.objectsRoot)
	}
}

async function appendHeader(file: FileHandle, header: LocalHeader): Promise<void> {
	const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
	if (headerBytes.byteLength > MAX_HEADER_BYTES) {
		throw new RangeError('Local S3 object header exceeds its format limit.')
	}
	await writeAll(file, headerBytes)
	const footer = Buffer.allocUnsafe(FOOTER_BYTES)
	footer.writeUInt32BE(headerBytes.byteLength, 0)
	FOOTER_MAGIC.copy(footer, 4)
	await writeAll(file, footer)
}

async function writeBody(
	file: FileHandle,
	data: PutData,
	signal: AbortSignal,
): Promise<{ size: number; etag: string }> {
	const body = toBodyStream(data)
	const reader = body.getReader()
	const hash = createHash('sha256')
	let size = 0
	const abort = (): void => void reader.cancel(signal.reason).catch((): undefined => undefined)
	signal.addEventListener('abort', abort, { once: true })
	try {
		while (true) {
			signal.throwIfAborted()
			const result = await reader.read()
			if (result.done) break
			if (!(result.value instanceof Uint8Array)) {
				throw new TypeError('S3 body stream must yield Uint8Array chunks.')
			}
			size += result.value.byteLength
			if (!Number.isSafeInteger(size)) throw new RangeError('S3 body is too large.')
			hash.update(result.value)
			await writeAll(file, result.value)
		}
		return { size, etag: hash.digest('hex') }
	} catch (error) {
		await reader.cancel(error).catch((): undefined => undefined)
		throw error
	} finally {
		signal.removeEventListener('abort', abort)
		reader.releaseLock()
	}
}

function toBodyStream(data: PutData): ReadableStream<Uint8Array> {
	if (isReadableStream(data)) return data as ReadableStream<Uint8Array>
	if (data instanceof Blob) return data.stream()
	let bytes: Uint8Array
	if (typeof data === 'string') bytes = new TextEncoder().encode(data)
	else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
	else if (data instanceof Uint8Array) bytes = data
	else throw new TypeError('[s3mini] data must be a string, bytes, Blob, File, or ReadableStream')
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) controller.enqueue(bytes)
			controller.close()
		},
	})
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { getReader?: unknown }).getReader === 'function'
	)
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null)
		if (bytesWritten === 0) throw new Error('Local S3 write made no progress.')
		offset += bytesWritten
	}
}

async function openLocalObject(path: string): Promise<OpenLocalObject | undefined> {
	let file: FileHandle
	try {
		file = await open(path, 'r')
	} catch (error) {
		if (errno(error) === 'ENOENT') return undefined
		throw error
	}
	try {
		const info = await file.stat()
		if (!info.isFile() || info.size < FOOTER_BYTES) throw corruptObject(path)
		const footer = Buffer.allocUnsafe(FOOTER_BYTES)
		await readExact(file, footer, info.size - FOOTER_BYTES)
		if (!footer.subarray(4).equals(FOOTER_MAGIC)) throw corruptObject(path)
		const headerLength = footer.readUInt32BE(0)
		if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) throw corruptObject(path)
		const headerStart = info.size - FOOTER_BYTES - headerLength
		if (headerStart < 0) throw corruptObject(path)
		const bytes = Buffer.allocUnsafe(headerLength)
		await readExact(file, bytes, headerStart)
		const header = parseHeader(bytes, path)
		if (header.size !== headerStart) throw corruptObject(path)
		return { file, header }
	} catch (error) {
		await file.close().catch((): undefined => undefined)
		throw error
	}
}

async function readExact(file: FileHandle, target: Uint8Array, position: number): Promise<void> {
	let offset = 0
	while (offset < target.byteLength) {
		const { bytesRead } = await file.read(
			target,
			offset,
			target.byteLength - offset,
			position + offset,
		)
		if (bytesRead === 0) throw new Error('Unexpected end of local S3 object file.')
		offset += bytesRead
	}
}

function parseHeader(bytes: Uint8Array, path: string): LocalHeader {
	let value: unknown
	try {
		value = JSON.parse(Buffer.from(bytes).toString('utf8'))
	} catch (error) {
		throw new Error(`Local S3 object has invalid metadata: ${path}`, { cause: error })
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw corruptObject(path)
	const header = value as Record<string, unknown>
	if (
		header.version !== FORMAT_VERSION ||
		typeof header.key !== 'string' ||
		!validStoredKey(header.key) ||
		!Number.isSafeInteger(header.size) ||
		(header.size as number) < 0 ||
		!validStoredContentType(header.contentType) ||
		typeof header.etag !== 'string' ||
		!/^[a-f0-9]{64}$/.test(header.etag) ||
		!Number.isSafeInteger(header.lastModifiedMs) ||
		(header.lastModifiedMs as number) < 0 ||
		!validStoredHeaders(header.headers)
	) {
		throw corruptObject(path)
	}
	return header as LocalHeader
}

function objectResponse(
	opened: OpenLocalObject,
	signal: AbortSignal,
	start = 0,
	endExclusive = opened.header.size,
	forcePartial = false,
): Response {
	const length = endExclusive - start
	let body: ReadableStream<Uint8Array>
	if (length === 0) {
		void opened.file.close()
		body = emptyBody()
	} else {
		const stream = opened.file.createReadStream({
			start,
			end: endExclusive - 1,
			autoClose: true,
			signal,
		})
		body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
	}
	const headers = new Headers(opened.header.headers)
	headers.set('content-type', opened.header.contentType)
	headers.set('content-length', String(length))
	headers.set('etag', quoteETag(opened.header.etag))
	headers.set('last-modified', new Date(opened.header.lastModifiedMs).toUTCString())
	headers.set('accept-ranges', 'bytes')
	const partial = forcePartial || start !== 0 || endExclusive !== opened.header.size
	if (partial)
		headers.set('content-range', `bytes ${start}-${endExclusive - 1}/${opened.header.size}`)
	return new Response(body, { status: partial ? 206 : 200, headers })
}

function bodyFromOpenObject(
	opened: OpenLocalObject,
	signal: AbortSignal,
): ReadableStream<Uint8Array> {
	if (opened.header.size === 0) {
		void opened.file.close()
		return emptyBody()
	}
	return Readable.toWeb(
		opened.file.createReadStream({
			start: 0,
			end: opened.header.size - 1,
			autoClose: true,
			signal,
		}),
	) as ReadableStream<Uint8Array>
}

function multipartBody(paths: string[], signal: AbortSignal): ReadableStream<Uint8Array> {
	const source = Readable.from(
		(async function* (): AsyncGenerator<Uint8Array> {
			for (const path of paths) {
				const file = await open(path, 'r')
				const stream = file.createReadStream({ autoClose: true, signal })
				for await (const chunk of stream) yield chunk as Uint8Array
			}
		})(),
	)
	return Readable.toWeb(source) as ReadableStream<Uint8Array>
}

async function hashFile(path: string): Promise<string> {
	const file = await open(path, 'r')
	const hash = createHash('sha256')
	try {
		for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
		return hash.digest('hex')
	} finally {
		await file.close()
	}
}

async function* walkObjectFiles(directory: string, signal: AbortSignal): AsyncGenerator<string> {
	signal.throwIfAborted()
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (errno(error) === 'ENOENT') return
		throw error
	}
	for (const entry of entries) {
		signal.throwIfAborted()
		const path = join(directory, entry.name)
		if (entry.isDirectory()) yield* walkObjectFiles(path, signal)
		else if (entry.isFile() && entry.name === OBJECT_FILE) yield path
	}
}

function toListObject(header: LocalHeader): ListObject {
	return {
		Key: header.key,
		Size: header.size,
		LastModified: new Date(header.lastModifiedMs),
		ETag: quoteETag(header.etag),
		StorageClass: header.headers['x-amz-storage-class'] ?? 'STANDARD',
	}
}

function evaluateConditions(
	header: LocalHeader,
	opts: Record<string, unknown>,
): { ok: true } | { ok: false; status: 304 | 412 } {
	const conditions = new Map<string, string>()
	for (const [name, value] of Object.entries(opts)) {
		const lower = name.toLowerCase()
		if (
			!['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].includes(lower)
		) {
			throw new S3UnsupportedOperationError(`local S3 query option ${name}`)
		}
		if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`)
		conditions.set(lower, value)
	}
	const etag = header.etag
	const ifMatch = conditions.get('if-match')
	if (ifMatch && ifMatch !== '*' && !etagList(ifMatch).includes(etag))
		return { ok: false, status: 412 }
	const unmodifiedSince = conditions.get('if-unmodified-since')
	if (
		!ifMatch &&
		unmodifiedSince &&
		httpDateTime(header.lastModifiedMs) > validHttpDate(unmodifiedSince)
	) {
		return { ok: false, status: 412 }
	}
	const ifNoneMatch = conditions.get('if-none-match')
	if (ifNoneMatch && (ifNoneMatch === '*' || etagList(ifNoneMatch).includes(etag))) {
		return { ok: false, status: 304 }
	}
	const modifiedSince = conditions.get('if-modified-since')
	if (
		!ifNoneMatch &&
		modifiedSince &&
		httpDateTime(header.lastModifiedMs) <= validHttpDate(modifiedSince)
	) {
		return { ok: false, status: 304 }
	}
	return { ok: true }
}

function httpDateTime(milliseconds: number): number {
	return Math.floor(milliseconds / 1_000) * 1_000
}

function etagList(value: string): string[] {
	return value.split(',').map((item) => sanitizeETag(item.trim().replace(/^W\//, '')))
}

function validHttpDate(value: string): number {
	const result = Date.parse(value)
	if (!Number.isFinite(result)) throw new TypeError('Conditional date must be a valid HTTP date.')
	return result
}

function normalizeAdditionalHeaders(value?: object): Record<string, string> {
	if (value === undefined) return {}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('S3 additional headers must be a record.')
	}
	const result: Record<string, string> = {}
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		const lower = name.toLowerCase()
		if (!lower.startsWith('x-amz-')) {
			throw new TypeError(`S3 additional header must start with x-amz-: ${name}`)
		}
		if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) {
			throw new TypeError(`Invalid S3 header name: ${name}`)
		}
		result[lower] = validHeaderValue(String(raw))
	}
	return result
}

function metadataHeaders(metadata?: Record<string, string>): Record<string, string> {
	if (metadata === undefined) return {}
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		throw new TypeError('S3 metadata must be a record.')
	}
	const headers: Record<string, string> = {}
	for (const [name, value] of Object.entries(metadata)) {
		const header = name.toLowerCase().startsWith('x-amz-meta-')
			? name.toLowerCase()
			: `x-amz-meta-${name.toLowerCase()}`
		headers[header] = validHeaderValue(value)
	}
	return headers
}

function validHeaderValue(value: string): string {
	if (/\r|\n/.test(value) || Buffer.byteLength(value, 'utf8') > 8 * 1_024) {
		throw new TypeError('S3 header value is invalid or too large.')
	}
	return value
}

function assertNoSSEC(value: unknown, operation: string): void {
	if (value !== undefined) throw new S3UnsupportedOperationError(operation)
}

function assertEmptyOptions(value: object, operation: string): void {
	const names = Object.keys(value)
	if (names.length > 0) {
		throw new S3UnsupportedOperationError(`${operation} (${names.join(', ')})`)
	}
}

function normalizeDeleteTarget(target: string | DeleteObject): DeleteObject {
	if (typeof target === 'string') {
		validateKey(target)
		return { key: target }
	}
	if (!target || typeof target !== 'object' || typeof target.key !== 'string') {
		throw new TypeError('[s3mini] delete target must be a key string or { key, versionId? }')
	}
	validateKey(target.key)
	if (target.versionId !== undefined && typeof target.versionId !== 'string') {
		throw new TypeError('[s3mini] versionId must be a string when provided')
	}
	return { key: target.key, versionId: target.versionId || undefined }
}

function validateKey(key: string): void {
	if (typeof key !== 'string' || key.trim().length === 0) {
		throw new TypeError('[s3mini] key must be a non-empty string')
	}
	if (!validStoredKey(key)) {
		throw new TypeError('S3 key must be well-formed Unicode and at most 1,024 UTF-8 bytes.')
	}
}

function validStoredKey(key: string): boolean {
	return isWellFormed(key) && Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES
}

function validatePrefix(prefix: string): void {
	if (typeof prefix !== 'string') throw new TypeError('[s3mini] prefix must be a string')
	if (!isWellFormed(prefix) || Buffer.byteLength(prefix, 'utf8') > MAX_KEY_BYTES) {
		throw new TypeError('S3 prefix must be well-formed Unicode and at most 1,024 UTF-8 bytes.')
	}
}

function validateDelimiter(delimiter: string): void {
	if (typeof delimiter !== 'string' || delimiter.trim().length === 0) {
		throw new TypeError('[s3mini] delimiter must be a string')
	}
	if (!isWellFormed(delimiter)) throw new TypeError('S3 delimiter must be well-formed Unicode.')
}

function validateContentType(value: string): void {
	if (typeof value !== 'string' || value.length === 0 || /\r|\n/.test(value)) {
		throw new TypeError('S3 content type must be a non-empty header value.')
	}
}

function validMaxKeys(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError('S3 maxKeys must be a positive integer.')
	}
	return value
}

function validRangeValue(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer.`)
	}
	return value
}

function validateUploadId(value: string): void {
	if (!isUploadId(value)) throw new TypeError('[s3mini] uploadId must be a valid local upload ID')
}

function isUploadId(value: string): boolean {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	)
}

function parseMultipartManifest(raw: string, uploadId: string): MultipartManifest {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch (error) {
		throw new Error(`Local multipart manifest is corrupt: ${uploadId}`, { cause: error })
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Local multipart manifest is corrupt: ${uploadId}`)
	}
	const manifest = value as Record<string, unknown>
	if (
		manifest.version !== FORMAT_VERSION ||
		manifest.uploadId !== uploadId ||
		typeof manifest.key !== 'string' ||
		!validStoredKey(manifest.key) ||
		!validStoredContentType(manifest.contentType) ||
		!validStoredHeaders(manifest.headers) ||
		!Number.isSafeInteger(manifest.createdAtMs)
	) {
		throw new Error(`Local multipart manifest is corrupt: ${uploadId}`)
	}
	return manifest as MultipartManifest
}

function validStoredContentType(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !/\r|\n/.test(value)
}

function validStoredHeaders(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	return Object.entries(value).every(
		([name, entry]) =>
			name.startsWith('x-amz-') &&
			typeof entry === 'string' &&
			!entry.includes('\r') &&
			!entry.includes('\n'),
	)
}

function encodePathComponents(value: string): string[] {
	const encoded = encodeBase32(value)
	const components: string[] = []
	for (let offset = 0; offset < encoded.length; offset += PATH_CHUNK_LENGTH) {
		components.push(encoded.slice(offset, offset + PATH_CHUNK_LENGTH))
	}
	return components
}

function encodeBase32(value: string): string {
	const bytes = Buffer.from(value, 'utf8')
	let bits = 0
	let bitCount = 0
	let result = ''
	for (const byte of bytes) {
		bits = (bits << 8) | byte
		bitCount += 8
		while (bitCount >= 5) {
			bitCount -= 5
			result += BASE32_ALPHABET[(bits >>> bitCount) & 31]
		}
	}
	if (bitCount > 0) result += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31]
	return result
}

function encodeContinuationToken(delimiter: string, prefix: string, key: string): string {
	return Buffer.from(JSON.stringify({ v: 1, delimiter, prefix, key }), 'utf8').toString('base64url')
}

function decodeContinuationToken(token: string, delimiter: string, prefix: string): string {
	let value: unknown
	try {
		value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
	} catch (error) {
		throw new TypeError('Invalid local S3 continuation token.', { cause: error })
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid local S3 continuation token.')
	}
	const cursor = value as Record<string, unknown>
	if (
		cursor.v !== 1 ||
		cursor.delimiter !== delimiter ||
		cursor.prefix !== prefix ||
		typeof cursor.key !== 'string'
	) {
		throw new TypeError('Local S3 continuation token belongs to another listing.')
	}
	return cursor.key
}

function quoteETag(value: string): string {
	return `"${sanitizeETag(value)}"`
}

function encodeS3Key(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/')
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path)
		return info.isDirectory()
	} catch (error) {
		if (errno(error) === 'ENOENT') return false
		throw error
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === 'win32') return
	const directory = await open(path, 'r')
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

async function pruneEmptyDirectories(path: string, root: string): Promise<void> {
	let current = path
	while (current !== root) {
		try {
			await rmdir(current)
		} catch (error) {
			if (errno(error) === 'ENOENT') return
			if (errno(error) === 'ENOTEMPTY' || errno(error) === 'EEXIST') return
			throw error
		}
		const parent = dirname(current)
		if (parent === current) return
		current = parent
	}
}

function isWellFormed(value: string): boolean {
	const candidate = value as string & { isWellFormed?: () => boolean }
	return typeof candidate.isWellFormed === 'function'
		? candidate.isWellFormed()
		: !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}

function emptyBody(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close()
		},
	})
}

function corruptObject(path: string): Error {
	return new Error(`Local S3 object file is corrupt or unsupported: ${path}`)
}

function errno(error: unknown): unknown {
	return error && typeof error === 'object' && 'code' in error
		? (error as { code?: unknown }).code
		: undefined
}
