import { DEFAULT_ZHIPU_LAYOUT_MODEL } from '../constants'
import type { ProviderDescriptor } from '../provider/contracts'

export const zhipuProviderDescriptor: ProviderDescriptor = {
	id: 'zhipu',
	label: 'Zhipu OpenAPI',
	pluginId: 'ZhipuProviderPlugin',
	operations: [
		{
			id: 'ocr.layout_parsing',
			label: 'GLM OCR layout parsing',
			path: '/layout_parsing',
			method: 'POST',
			defaultModel: DEFAULT_ZHIPU_LAYOUT_MODEL,
			unitName: 'request',
		},
		{
			id: 'ocr.files',
			label: 'Files OCR',
			path: '/files/ocr',
			method: 'POST',
			unitName: 'request',
		},
		{
			id: 'chat.completions',
			label: 'Chat completions',
			path: '/chat/completions',
			method: 'POST',
			unitName: 'token',
		},
		{
			id: 'embeddings.create',
			label: 'Embeddings',
			path: '/embeddings',
			method: 'POST',
			unitName: 'token',
		},
		{
			id: 'rerank.create',
			label: 'Rerank',
			path: '/rerank',
			method: 'POST',
			unitName: 'request',
		},
		{
			id: 'reader',
			label: 'Reader',
			path: '/reader',
			method: 'POST',
			unitName: 'request',
		},
		{
			id: 'moderations.create',
			label: 'Moderations',
			path: '/moderations',
			method: 'POST',
			unitName: 'request',
		},
		{
			id: 'web_search',
			label: 'Web search',
			path: '/web_search',
			method: 'POST',
			unitName: 'request',
		},
	],
}
