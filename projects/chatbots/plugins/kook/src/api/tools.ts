import { MessageType } from '../types/index.ts'
import type {
	KookApi,
	KookApiTools,
	KookConversation,
	KookDirectConversation,
	Result,
} from './types.ts'

export function createKookTools(api: KookApi): KookApiTools {
	return {
		async createAsset(file, name = 'asset') {
			const result = await api.createAsset(toFormData(file, name))
			if ('message' in result) return result
			return { ok: true, data: result.data.url }
		},
		createMessageBuilder: (targetId, defaults) => createConversation(api, targetId, defaults).send,
		createConversation: (targetId, defaults) => createConversation(api, targetId, defaults),
		createDirectMessageBuilder: (direct, defaults) =>
			createDirectConversation(api, direct, defaults).send,
		createDirectConversation: (direct, defaults) => createDirectConversation(api, direct, defaults),
	}
}

function createConversation(
	api: KookApi,
	target_id: string,
	defaults?: KookConversation['defaults'],
): KookConversation {
	let trackedId: string | undefined
	const options = <T extends object | undefined>(value: T) => ({ ...defaults, ...value })

	const send: KookConversation['send'] = async (content, value) => {
		const result = await api.sendMessage({ target_id, content, ...options(value) })
		if (result.ok) trackedId = result.data.msg_id
		return result
	}
	const reply: KookConversation['reply'] = (quote, content, value) =>
		send(content, { ...value, quote })
	const edit: KookConversation['edit'] = (msg_id, content, value) =>
		api.updateMessage({ msg_id, content, ...options(value) })
	const remove: KookConversation['delete'] = (msg_id) => api.deleteMessage({ msg_id })
	const editLast: KookConversation['editLast'] = (content, value) =>
		trackedId ? edit(trackedId, content, value) : missingTracked()
	const deleteLast: KookConversation['deleteLast'] = () =>
		trackedId ? remove(trackedId) : missingTracked()
	const upsert: KookConversation['upsert'] = async (content, value) => {
		if (trackedId) {
			const result = await edit(trackedId, content, {
				...value,
				type:
					value?.type === MessageType.kmarkdown || value?.type === MessageType.card
						? value.type
						: undefined,
			})
			if (result.ok) return result
			trackedId = undefined
		}
		return send(content, value)
	}
	const transient: KookConversation['transient'] = async (content, value, ttlMs = 5_000) => {
		const result = await send(content, value)
		if (result.ok && result.data.msg_id && ttlMs > 0) {
			scheduleDelete(() => remove(result.data.msg_id), ttlMs)
		}
		return result
	}
	const track: KookConversation['track'] = (msgId) => {
		trackedId = msgId || undefined
		return trackedId
	}

	return {
		target_id,
		defaults,
		get lastMessageId() {
			return trackedId
		},
		send,
		reply,
		edit,
		editLast,
		delete: remove,
		deleteLast,
		upsert,
		transient,
		track,
		withDefaults(value) {
			const next = createConversation(api, target_id, { ...defaults, ...value })
			if (trackedId) next.track(trackedId)
			return next
		},
	}
}

function createDirectConversation(
	api: KookApi,
	direct: KookDirectConversation['direct'],
	defaults?: KookDirectConversation['defaults'],
): KookDirectConversation {
	let trackedId: string | undefined
	const options = <T extends object | undefined>(value: T) => ({ ...defaults, ...value })

	const send: KookDirectConversation['send'] = async (content, value) => {
		const result = await api.createDirectMessage({ ...direct, content, ...options(value) })
		if (result.ok) trackedId = result.data.msg_id
		return result
	}
	const reply: KookDirectConversation['reply'] = (quote, content, value) =>
		send(content, { ...value, quote })
	const edit: KookDirectConversation['edit'] = (msg_id, content, value) =>
		api.updateDirectMessage({ msg_id, content, ...options(value) })
	const remove: KookDirectConversation['delete'] = (msg_id) => api.deleteDirectMessage({ msg_id })
	const editLast: KookDirectConversation['editLast'] = (content, value) =>
		trackedId ? edit(trackedId, content, value) : missingTracked()
	const deleteLast: KookDirectConversation['deleteLast'] = () =>
		trackedId ? remove(trackedId) : missingTracked()
	const upsert: KookDirectConversation['upsert'] = async (content, value) => {
		if (trackedId) {
			const result = await edit(trackedId, content, value)
			if (result.ok) return result
			trackedId = undefined
		}
		return send(content, value)
	}
	const transient: KookDirectConversation['transient'] = async (content, value, ttlMs = 5_000) => {
		const result = await send(content, value)
		if (result.ok && result.data.msg_id && ttlMs > 0) {
			scheduleDelete(() => remove(result.data.msg_id), ttlMs)
		}
		return result
	}
	const track: KookDirectConversation['track'] = (msgId) => {
		trackedId = msgId || undefined
		return trackedId
	}

	return {
		direct,
		defaults,
		get lastMessageId() {
			return trackedId
		},
		send,
		reply,
		edit,
		editLast,
		delete: remove,
		deleteLast,
		upsert,
		transient,
		track,
		withDefaults(value) {
			const next = createDirectConversation(api, direct, { ...defaults, ...value })
			if (trackedId) next.track(trackedId)
			return next
		},
	}
}

function toFormData(
	file: Blob | ArrayBuffer | ArrayBufferView | string | FormData,
	name: string,
): FormData {
	if (file instanceof FormData) return file
	const form = new FormData()
	if (typeof file === 'string') form.append('file', file)
	else if (file instanceof Blob) form.append('file', file, name)
	else if (file instanceof ArrayBuffer) form.append('file', new Blob([file]), name)
	else {
		const copy = new Uint8Array(file.byteLength)
		copy.set(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
		form.append('file', new Blob([copy.buffer]), name)
	}
	return form
}

function missingTracked<T>(): Promise<Result<T>> {
	return Promise.resolve({ ok: false, code: -404, message: 'No tracked message' })
}

function scheduleDelete(task: () => Promise<unknown>, ttlMs: number): void {
	const timer = setTimeout(() => void task().catch((): void => undefined), ttlMs)
	if (typeof timer === 'object' && 'unref' in timer) timer.unref()
}
