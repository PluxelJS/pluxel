import { request as httpRequest } from 'node:http'

// Node fetch rewrites sec-fetch-mode to cors; navigation must preserve the wire headers.
/** @param {string} url @returns {Promise<{ status: number, text: string }>} */
export function requestDocument(url) {
	return new Promise((resolveResponse, reject) => {
		const request = httpRequest(
			url,
			{
				headers: {
					accept: 'text/html',
					'sec-fetch-dest': 'document',
					'sec-fetch-mode': 'navigate',
				},
			},
			(response) => {
				const chunks = []
				response.on('data', (chunk) => chunks.push(chunk))
				response.once('error', reject)
				response.once('end', () => {
					resolveResponse({
						status: response.statusCode ?? 0,
						text: Buffer.concat(chunks).toString('utf8'),
					})
				})
			},
		)
		request.once('error', reject)
		request.end()
	})
}
