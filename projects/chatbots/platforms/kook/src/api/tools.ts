import { MessageType } from '../types/index.ts'
import type {
	KookApi,
	KookApiTools,
	KookChannelMessageOptions,
	KookConversation,
	KookDirectConversation,
} from './types.ts'

export function createKookTools(api: KookApi, ownerSignal?: AbortSignal): KookApiTools {
	return {
		async createAsset(file, name = 'asset') {
			const result = await api.createAsset(toFormData(file, name))
			if ('message' in result) return result
			return { ok: true, data: result.data.url }
		},
		createConversation: (targetId, defaults) =>
			createConversation(api, targetId, defaults, ownerSignal),
		createDirectConversation: (direct, defaults) =>
			createDirectConversation(api, direct, defaults, ownerSignal),
	}
}

function createConversation(
	api: KookApi,
	target_id: string,
	defaults?: KookConversation['defaults'],
	signal?: AbortSignal,
): KookConversation {
	const defaultSnapshot = freezeSnapshot(defaults)
	const options = <T extends object | undefined>(value: T) => ({ ...defaultSnapshot, ...value })

	const send: KookConversation['send'] = (content, value) =>
		api.$.raw.call('sendMessage', { target_id, content, ...options(value) }, { signal })
	const reply: KookConversation['reply'] = (quote, content, value) =>
		send(content, { ...value, quote })
	const edit: KookConversation['edit'] = (msg_id, content, value) => {
		const merged = options(value)
		const type =
			merged.type === MessageType.kmarkdown || merged.type === MessageType.card
				? merged.type
				: undefined
		return api.$.raw.call('updateMessage', { msg_id, content, ...merged, type }, { signal })
	}
	const remove: KookConversation['delete'] = (msg_id) =>
		api.$.raw.call('deleteMessage', { msg_id }, { signal })
	const sendOrEdit: KookConversation['sendOrEdit'] = async ({ msg_id, content, ...value }) => {
		if (msg_id) {
			const result = await edit(msg_id, content, toChannelEditOptions(value))
			if ('message' in result) return result
			return { ok: true, data: msg_id }
		}
		const result = await send(content, value)
		if ('message' in result) return result
		return { ok: true, data: result.data.msg_id }
	}

	const conversation: KookConversation = {
		target_id,
		defaults: defaultSnapshot,
		send,
		reply,
		edit,
		delete: remove,
		sendOrEdit,
		withSignal(nextSignal) {
			return createConversation(api, target_id, defaultSnapshot, combineSignals(signal, nextSignal))
		},
	}
	return Object.freeze(conversation)
}

function createDirectConversation(
	api: KookApi,
	direct: KookDirectConversation['direct'],
	defaults?: KookDirectConversation['defaults'],
	signal?: AbortSignal,
): KookDirectConversation {
	const directSnapshot = freezeSnapshot(direct)!
	const defaultSnapshot = freezeSnapshot(defaults)
	const options = <T extends object | undefined>(value: T) => ({ ...defaultSnapshot, ...value })

	const send: KookDirectConversation['send'] = (content, value) =>
		api.$.raw.call(
			'createDirectMessage',
			{ ...directSnapshot, content, ...options(value) },
			{ signal },
		)
	const reply: KookDirectConversation['reply'] = (quote, content, value) =>
		send(content, { ...value, quote })
	const edit: KookDirectConversation['edit'] = (msg_id, content, value) => {
		const { type: _type, ...editable } = options(value)
		return api.$.raw.call('updateDirectMessage', { msg_id, content, ...editable }, { signal })
	}
	const remove: KookDirectConversation['delete'] = (msg_id) =>
		api.$.raw.call('deleteDirectMessage', { msg_id }, { signal })
	const sendOrEdit: KookDirectConversation['sendOrEdit'] = async ({
		msg_id,
		content,
		...value
	}) => {
		if (msg_id) {
			const result = await edit(msg_id, content, value)
			if ('message' in result) return result
			return { ok: true, data: msg_id }
		}
		const result = await send(content, value)
		if ('message' in result) return result
		return { ok: true, data: result.data.msg_id }
	}

	const conversation: KookDirectConversation = {
		direct: directSnapshot,
		defaults: defaultSnapshot,
		send,
		reply,
		edit,
		delete: remove,
		sendOrEdit,
		withSignal(nextSignal) {
			return createDirectConversation(
				api,
				directSnapshot,
				defaultSnapshot,
				combineSignals(signal, nextSignal),
			)
		},
	}
	return Object.freeze(conversation)
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

function freezeSnapshot<T extends object>(value: T | undefined): Readonly<T> | undefined {
	return value === undefined ? undefined : Object.freeze({ ...value })
}

function toChannelEditOptions(
	value: KookChannelMessageOptions | undefined,
): Parameters<KookConversation['edit']>[2] {
	if (!value) return undefined
	const { type, ...rest } = value
	if (!Object.hasOwn(value, 'type')) return rest
	return {
		...rest,
		type: type === MessageType.kmarkdown || type === MessageType.card ? type : undefined,
	}
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = [
		...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined)),
	]
	if (active.length === 0) return undefined
	return active.length === 1 ? active[0] : AbortSignal.any(active)
}
