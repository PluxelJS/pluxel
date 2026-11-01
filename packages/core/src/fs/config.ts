import {
	bindContext,
	checkOptions,
	configureFileSystem,
	DeviceFS,
	InMemory,
	isBackend,
	isBackendConfig,
	vfs,
	type Backend,
	type BackendConfiguration,
	type BoundContext,
	type Configuration,
	type ConfigMounts,
	type FileSystem,
	type MountConfiguration,
	type SharedConfig,
} from '@zenfs/core'
import { normalize } from 'pathe'
import { withErrno } from 'kerium'

type LocalConfiguration<T extends ConfigMounts> = Omit<
	Partial<Configuration<T>>,
	'log' | 'disableAccessChecks' | 'resolveFullWalk' | 'onlySyncOnClose' | 'mounts'
>

/** Native mount inputs remain open to backend-specific options. Use BackendConfiguration<B> for exact option checks. */
type OpenMountConfiguration =
	| MountConfiguration<Backend>
	| (BackendConfiguration<Backend> & Record<string, unknown>)

/**
 * Per-Core ZenFS configuration. Global ZenFS logging/permission switches and the
 * upstream unimplemented onlySyncOnClose option are intentionally excluded.
 */
export type FsConfig<T extends ConfigMounts = ConfigMounts> = LocalConfiguration<T> & {
	mounts?: string extends keyof T
		? Record<string, OpenMountConfiguration>
		: Configuration<T>['mounts']
	/**
	 * Exact mount points whose owner warrants persistence across reopening.
	 * Child mounts need their own declaration. This does not promise crash durability.
	 * @defaultValue []
	 */
	durableMounts?: readonly string[]
}

export type ResolvedFsConfig = Readonly<
	LocalConfiguration<ConfigMounts> & {
		mounts: Readonly<Record<string, OpenMountConfiguration>>
		durableMounts: readonly string[]
	}
>

/** Match the native FileSystem protocol across independently installed ZenFS copies. */
function isFileSystem(value: unknown): value is FileSystem {
	if (!value || typeof value !== 'object') return false
	const fs = value as FileSystem
	return (
		typeof fs.ready === 'function' &&
		typeof fs.stat === 'function' &&
		typeof fs.statSync === 'function' &&
		typeof fs.read === 'function' &&
		typeof fs.rename === 'function' &&
		typeof fs.uuid === 'string' &&
		typeof fs.attributes?.has === 'function' &&
		typeof fs.attributes?.get === 'function'
	)
}

function pointOf(input: string): string {
	if (!input || input.includes('\\') || input.includes('\0') || /^[A-Za-z]:/.test(input))
		throw new TypeError(`[core.fs] invalid mount point: ${input}`)
	return normalize(input.startsWith('/') ? input : `/${input}`).replace(/\/$/, '') || '/'
}

function validateShared(config: SharedConfig): void {
	for (const key of ['readOnly', 'disableAsyncCache'] as const)
		if (config[key] !== undefined && typeof config[key] !== 'boolean')
			throw new TypeError(`[core.fs] ${key} must be a boolean`)
	if (config.caseFold !== undefined && config.caseFold !== 'upper' && config.caseFold !== 'lower')
		throw new TypeError('[core.fs] caseFold must be upper or lower')
}

/** Snapshot only native mount declarations; opaque backend resources remain borrowed values. */
function snapshotMount(input: unknown, active: Set<object>, depth: number): OpenMountConfiguration {
	if (isFileSystem(input)) return input
	if (isBackend(input)) return input
	if (!isBackendConfig(input))
		throw new TypeError('[core.fs] expected a native mount configuration')
	if (active.has(input) || depth > 10)
		throw new TypeError('[core.fs] cyclic or excessively deep native mount configuration')
	validateShared(input)
	active.add(input)
	try {
		const result: Record<string, unknown> = { ...input }
		for (const [key, value] of Object.entries(input)) {
			if (key !== 'backend' && (isFileSystem(value) || isBackend(value) || isBackendConfig(value)))
				result[key] = snapshotMount(value, active, depth + 1)
		}
		return Object.freeze(result) as BackendConfiguration<Backend> & Record<string, unknown>
	} finally {
		active.delete(input)
	}
}

/** Validate Core-local policy without initializing any backend or modifying caller input. */
export function snapshotFsConfig(config: FsConfig): ResolvedFsConfig {
	if (!config || typeof config !== 'object' || Array.isArray(config))
		throw new TypeError('[core.fs] expected a native ZenFS configuration object')
	const localFields = new Set([
		'mounts',
		'uid',
		'gid',
		'readOnly',
		'disableAsyncCache',
		'caseFold',
		'defaultDirectories',
		'addDevices',
		'durableMounts',
	])
	for (const key of Object.keys(config))
		if (!localFields.has(key))
			throw new TypeError(`[core.fs] unsupported configuration field: ${key}`)
	validateShared(config)
	for (const key of ['defaultDirectories', 'addDevices'] as const)
		if (config[key] !== undefined && typeof config[key] !== 'boolean')
			throw new TypeError(`[core.fs] ${key} must be a boolean`)
	for (const key of ['uid', 'gid'] as const)
		if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0))
			throw new TypeError(`[core.fs] ${key} must be a nonnegative safe integer`)
	if (
		config.mounts !== undefined &&
		(!config.mounts || typeof config.mounts !== 'object' || Array.isArray(config.mounts))
	)
		throw new TypeError('[core.fs] mounts must be a native mount-point record')
	const mounts: Record<string, OpenMountConfiguration> = Object.create(null)
	for (const [path, input] of Object.entries(config.mounts ?? {})) {
		const point = pointOf(path)
		if (Object.hasOwn(mounts, point))
			throw new TypeError(`[core.fs] duplicate mount point: ${point}`)
		mounts[point] = snapshotMount(input, new Set(), 0)
	}
	if (!Object.hasOwn(mounts, '/')) mounts['/'] = InMemory
	if (config.durableMounts !== undefined && !Array.isArray(config.durableMounts))
		throw new TypeError('[core.fs] durableMounts must be an array of mount points')
	const durableMounts = (config.durableMounts ?? []).map((path) => {
		if (typeof path !== 'string')
			throw new TypeError('[core.fs] durableMounts entries must be strings')
		const point = pointOf(path)
		if (!Object.hasOwn(mounts, point))
			throw new TypeError(`[core.fs] durableMounts references an undeclared mount: ${path}`)
		return point
	})
	return Object.freeze({
		...config,
		mounts: Object.freeze(mounts),
		durableMounts: Object.freeze(durableMounts),
	})
}

/** A borrowed view isolates VFS attributes/cache identity without changing or closing its source. */
function borrowedView(source: FileSystem): FileSystem {
	const view = Object.create(source) as FileSystem
	Object.defineProperties(view, {
		attributes: { value: new Map(source.attributes), enumerable: true },
		uuid: { value: crypto.randomUUID(), enumerable: true },
	})
	return new Proxy(view, {
		get(target, key, receiver) {
			if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver)
			const value = Reflect.get(source, key, source)
			// A composing backend receives a borrowed child too. Its own cleanup must
			// not release the caller's resource through the view's disposal methods.
			if (typeof value === 'function') {
				if (key === 'close' || key === Symbol.dispose) return () => {}
				if (key === Symbol.asyncDispose) return async () => {}
			}
			return typeof value === 'function' && key !== 'constructor' ? value.bind(source) : value
		},
	})
}

/** Own native backend creation and a private mount table; direct FileSystems are borrowed. */
export class FsMounts {
	readonly context: BoundContext
	private readonly owned = new Map<FileSystem, () => Promise<unknown>>()
	private readonly borrowed = new Set<FileSystem>()
	private readonly views = new Map<FileSystem, FileSystem>()
	private readonly borrowedViews = new Set<FileSystem>()
	private readonly managed = new Map<FileSystem, FileSystem>()
	private disposal?: Promise<void>

	constructor(private readonly config: ResolvedFsConfig) {
		this.context = bindContext({
			root: '/',
			pwd: '/',
			mounts: {},
			credentials: { uid: config.uid ?? 0, gid: config.gid ?? 0 },
		})
	}

	async open(): Promise<BoundContext> {
		try {
			for (const [point, input] of Object.entries(this.config.mounts).sort(
				([a], [b]) => a.length - b.length,
			)) {
				const fs = await this.resolve(input)
				if (point !== '/') await this.ensureMountDirectory(point)
				vfs.mount.call(this.context, point, fs)
			}
			if (this.config.addDevices && !this.context.mounts.has('/dev')) {
				const devices = new DeviceFS()
				const fs = this.own(devices)
				devices.addDefaults()
				await fs.ready()
				await this.ensureMountDirectory('/dev')
				vfs.mount.call(this.context, '/dev', fs)
			}
			for (const fs of this.context.mounts.values()) configureFileSystem(fs, this.config)
			if (this.config.defaultDirectories)
				for (const path of ['/tmp', '/var', '/etc']) await this.ensureMountDirectory(path)
			return this.context
		} catch (cause) {
			const cleanup: unknown[] = []
			await this.dispose().catch((error: unknown) => {
				cleanup.push(error)
			})
			if (cleanup.length > 0)
				throw new AggregateError(
					[cause, ...cleanup],
					'Failed to prepare and close Host filesystem',
					{ cause },
				)
			throw cause
		}
	}

	private resolve(input: OpenMountConfiguration): Promise<FileSystem> {
		return this.create(input)
	}

	/** A composing backend and Core share one disposal, even if both release a child. */
	private own(source: FileSystem): FileSystem {
		const known = this.managed.get(source)
		if (known) return known
		let disposal: Promise<unknown> | undefined
		let started = false
		let synchronousFailure: { error: unknown } | undefined
		const nativeDispose = () => {
			for (const key of [Symbol.asyncDispose, 'close', Symbol.dispose]) {
				const method = Reflect.get(source, key, source)
				if (typeof method === 'function') return method.call(source)
			}
		}
		const release = (): Promise<unknown> => {
			if (!started) {
				started = true
				disposal = Promise.resolve().then(nativeDispose)
			}
			return disposal ?? Promise.resolve()
		}
		const releaseSync = (): void => {
			if (started) {
				if (synchronousFailure) throw synchronousFailure.error
				return
			}
			started = true
			try {
				disposal = Promise.resolve(nativeDispose())
			} catch (error) {
				synchronousFailure = { error }
				disposal = Promise.reject(error)
				throw error
			} finally {
				// A parent can invoke a synchronous protocol before Core awaits the
				// shared release task. Keep a failed task observable without a detached rejection.
				void disposal?.catch(() => {})
			}
		}
		const view = new Proxy(Object.create(source) as FileSystem, {
			get(target, key, receiver) {
				if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver)
				const value = Reflect.get(source, key, source)
				if (typeof value !== 'function' || key === 'constructor') return value
				if (key === Symbol.dispose) return releaseSync
				if (key === 'close' || key === Symbol.asyncDispose) return release
				return value.bind(source)
			},
		})
		this.managed.set(source, view)
		this.managed.set(view, view)
		this.owned.set(view, release)
		return view
	}

	private async create(input: OpenMountConfiguration): Promise<FileSystem> {
		if (isFileSystem(input)) {
			this.borrowed.add(input)
			await input.ready()
			let view = this.views.get(input)
			if (!view) {
				view = borrowedView(input)
				this.views.set(input, view)
				this.borrowedViews.add(view)
			}
			return view
		}
		const config: Record<string, unknown> & BackendConfiguration<Backend> = isBackend(input)
			? { backend: input }
			: { ...input }
		config.disableAsyncCache ??= this.config.disableAsyncCache
		config.caseFold ??= this.config.caseFold
		for (const [key, value] of Object.entries(config))
			if (key !== 'backend' && (isFileSystem(value) || isBackend(value) || isBackendConfig(value)))
				config[key] = await this.resolve(value)
		const { backend } = config
		if (backend.isAvailable && !(await backend.isAvailable(config)))
			throw withErrno('EPERM', `Backend not available: ${backend.name}`)
		checkOptions(backend, config)
		const created = await backend.create(config)
		const fs =
			created &&
			typeof created === 'object' &&
			!this.borrowed.has(created) &&
			!this.borrowedViews.has(created)
				? this.own(created)
				: created
		if (!isFileSystem(fs))
			throw new TypeError(`[core.fs] Backend ${backend.name} did not return a native FileSystem`)
		configureFileSystem(fs, config)
		await fs.ready()
		return fs
	}

	private async ensureMountDirectory(path: string): Promise<void> {
		try {
			const stat = await this.context.fs.promises.stat(path)
			if (!stat.isDirectory()) throw withErrno('ENOTDIR', `Mount point is not a directory: ${path}`)
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
				throw error
			await this.context.fs.promises.mkdir(path, { recursive: true })
		}
	}

	dispose(): Promise<void> {
		return (this.disposal ??= (async () => {
			const errors: unknown[] = []
			try {
				await this.context.dispose()
			} catch (error) {
				errors.push(error)
			}
			for (const point of [...this.context.mounts.keys()].sort((a, b) => b.length - a.length))
				try {
					await vfs.umountAsync.call(this.context, point)
				} catch (error) {
					errors.push(error)
				}
			for (const release of [...this.owned.values()].toReversed()) {
				try {
					await release()
				} catch (error) {
					errors.push(error)
				}
			}
			this.owned.clear()
			this.views.clear()
			this.borrowedViews.clear()
			this.managed.clear()
			if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Host filesystem')
		})())
	}
}
