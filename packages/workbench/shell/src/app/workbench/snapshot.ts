import { useEffect } from 'react'
import { useWorkbenchState, type WorkbenchSnapshot } from '@worksplit/react'
import { useWorkspaceSession } from './workspaceContext'

export function workspaceStorageKey(basepath: string) {
	return `pluxel:worksplit:7:${basepath}`
}

export class WorkspaceRestoreError extends Error {
	constructor(
		readonly storage: WorkspaceSnapshotStorage,
		cause: unknown,
	) {
		super('工作区布局无法恢复。保存的现场未被改写；可以重试，或显式删除布局后重新打开。', { cause })
		storage.blocked = true
	}
}

/** Storage owns only a restore candidate and scheduled writes, never a second live layout. */
export class WorkspaceSnapshotStorage {
	blocked = false
	private error?: string
	private readonly listeners = new Set<() => void>()
	private source?: () => WorkbenchSnapshot
	private timer?: ReturnType<typeof setTimeout>
	private last?: string
	private pending = false

	constructor(
		readonly key: string,
		private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
	) {}
	private backend() {
		return this.storage ?? window.localStorage
	}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	getSnapshot = () => this.error
	private fail(cause: unknown) {
		const message = `布局未能保存或读取：${cause instanceof Error ? cause.message : String(cause)}`
		if (this.error === message) return
		this.error = message
		for (const listener of this.listeners) listener()
	}
	private clearError() {
		if (!this.error) return
		this.error = undefined
		for (const listener of this.listeners) listener()
	}
	readSnapshot(): unknown {
		let raw: string | null
		try {
			raw = this.backend().getItem(this.key)
		} catch (cause) {
			this.fail(cause)
			return undefined
		}
		if (raw === null) return undefined
		try {
			const candidate: unknown = JSON.parse(raw)
			this.last = raw
			return candidate
		} catch (cause) {
			throw new WorkspaceRestoreError(this, cause)
		}
	}
	connect(source: () => WorkbenchSnapshot) {
		this.source = source
		window.addEventListener('pagehide', this.flush)
		document.addEventListener('visibilitychange', this.onVisibility)
	}
	schedule = () => {
		this.pending = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(this.flush, 180)
	}
	flush = () => {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		if (!this.pending || !this.source || this.blocked) return
		try {
			const raw = JSON.stringify(this.source())
			if (raw !== this.last) this.backend().setItem(this.key, raw)
			this.last = raw
			this.pending = false
			this.clearError()
		} catch (cause) {
			this.fail(cause)
		}
	}
	retry = () => {
		this.pending = true
		this.flush()
	}
	write(snapshot: WorkbenchSnapshot): boolean {
		try {
			this.backend().setItem(this.key, JSON.stringify(snapshot))
			this.pending = false
			this.clearError()
			return true
		} catch (cause) {
			this.fail(cause)
			return false
		}
	}
	reset(): boolean {
		try {
			this.backend().removeItem(this.key)
			this.blocked = false
			this.last = undefined
			this.clearError()
			return true
		} catch (cause) {
			this.fail(cause)
			return false
		}
	}
	private onVisibility = () => {
		if (document.visibilityState === 'hidden') this.flush()
	}
	close() {
		this.flush()
		window.removeEventListener('pagehide', this.flush)
		document.removeEventListener('visibilitychange', this.onVisibility)
	}
}

export function WorkspacePersistence() {
	const session = useWorkspaceSession()
	const revision = useWorkbenchState(session.workbench, (state) => state.revision)
	useEffect(() => {
		session.storage.schedule()
	}, [revision, session])
	return null
}
