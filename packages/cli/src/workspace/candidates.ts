import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'pathe'

const STORE_DIR = '.pluxel'
const STORE_FILE = 'workspaces.json'
const STORE_VERSION = 1

export interface WorkspaceCandidate {
	path: string
	lastSeen: number
	source?: string
}

export interface WorkspaceCandidateStore {
	path: string
	entries: WorkspaceCandidate[]
}

interface WorkspaceCandidatePayload {
	version: number
	entries?: WorkspaceCandidate[]
}

export function readWorkspaceCandidates(root: string): WorkspaceCandidateStore | undefined {
	const path = storePath(root)
	if (!existsSync(path)) return undefined
	try {
		const payload = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceCandidatePayload
		const entries = Array.isArray(payload.entries) ? payload.entries : []
		return normalizeStore(path, entries)
	} catch {
		return undefined
	}
}

export function writeWorkspaceCandidates(
	root: string,
	entries: WorkspaceCandidate[],
): WorkspaceCandidateStore {
	const path = storePath(root)
	mkdirSync(dirname(path), { recursive: true })
	const normalized = normalizeEntries(entries)
	const payload: WorkspaceCandidatePayload = { version: STORE_VERSION, entries: normalized }
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
	return { path, entries: normalized }
}

export function upsertWorkspaceCandidates(
	root: string,
	paths: string[],
	store?: WorkspaceCandidateStore,
	source?: string,
) {
	const now = Date.now()
	const map = new Map<string, WorkspaceCandidate>()
	for (const entry of store?.entries || []) {
		map.set(entry.path, entry)
	}
	for (const raw of paths) {
		const path = normalizeCandidatePath(raw)
		if (!path) continue
		const next: WorkspaceCandidate = {
			path,
			lastSeen: now,
			source: source || map.get(path)?.source,
		}
		map.set(path, next)
	}
	return writeWorkspaceCandidates(root, [...map.values()])
}

export function storePath(root: string) {
	return resolve(root, STORE_DIR, STORE_FILE)
}

function normalizeStore(path: string, entries: WorkspaceCandidate[]): WorkspaceCandidateStore {
	return {
		path,
		entries: normalizeEntries(entries),
	}
}

function normalizeEntries(entries: WorkspaceCandidate[]): WorkspaceCandidate[] {
	const map = new Map<string, WorkspaceCandidate>()
	for (const entry of entries) {
		const path = normalizeCandidatePath(entry.path)
		if (!path) continue
		const lastSeen = Number(entry.lastSeen) || Date.now()
		map.set(path, {
			path,
			lastSeen,
			source: entry.source,
		})
	}
	return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function normalizeCandidatePath(input: string | undefined) {
	if (!input) return ''
	return input
		.replace(/\\/g, '/')
		.replace(/^\.\/+/, '')
		.replace(/\/+$/, '')
}
