import type { StudioError } from '../shared/contracts'

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly detail: StudioError,
	) {
		super(detail.error)
	}
}

/** The entire business transport is Electron IPC -> Elysia.fetch; no HTTP listener. */
export async function request(
	path: string,
	init: { method?: string; body?: unknown; bytes?: Uint8Array } = {},
): Promise<Uint8Array> {
	const result = await window.studio.fetch({
		path,
		method: init.method ?? 'GET',
		headers: init.body === undefined ? [] : [['content-type', 'application/json']],
		...(init.bytes
			? { body: init.bytes }
			: init.body === undefined
				? {}
				: { body: new TextEncoder().encode(JSON.stringify(init.body)) }),
	})
	if (result.status < 200 || result.status >= 300) {
		let detail: StudioError
		try {
			detail = JSON.parse(new TextDecoder().decode(result.body)) as StudioError
		} catch {
			detail = { error: `请求失败 (${result.status})` }
		}
		throw new ApiError(result.status, detail)
	}
	return result.body
}

export async function api<T>(path: string, init?: Parameters<typeof request>[1]): Promise<T> {
	const bytes = await request(path, init)
	return bytes.byteLength ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : (undefined as T)
}
