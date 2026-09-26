import { normalizePath } from 'vite'

/** Decode Vite's filesystem URL spelling without interpreting it as a project-relative URL. */
export function viteFsPath(id: string): string | undefined {
	const clean = id.split(/[?#]/, 1)[0]!
	if (!clean.startsWith('/@fs/')) return undefined
	const path = clean.slice('/@fs/'.length).replaceAll('\\', '/')
	const drive = path.replace(/^\/+(?=[a-zA-Z]:\/)/, '')
	return normalizePath(/^[a-zA-Z]:\//.test(drive) ? drive : `/${path}`)
}
