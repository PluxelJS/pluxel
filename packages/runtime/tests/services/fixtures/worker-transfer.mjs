import { threadId } from 'node:worker_threads'

export default function run({ bytes }) {
	return {
		byteLength: bytes.byteLength,
		first: bytes[0],
		last: bytes[bytes.byteLength - 1],
		threadId,
	}
}
