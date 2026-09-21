import { threadId } from 'node:worker_threads'

export default function run(input: { value: number }): { value: number; threadId: number } {
	return { value: input.value * 2, threadId }
}
