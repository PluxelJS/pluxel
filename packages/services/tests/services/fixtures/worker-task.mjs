import { threadId } from 'node:worker_threads'

export default async function run(input) {
	const started = Date.now()
	if (input.delay > 0) await new Promise((resolve) => setTimeout(resolve, input.delay))
	return { label: input.label, threadId, started, ended: Date.now() }
}
