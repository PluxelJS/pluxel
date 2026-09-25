interface ToyRpc {
	invoke(input: { text: string; delayMs: number }): Promise<{ echoed: string }>
}

async function run(rpc: ToyRpc) {
	const outcomes = []
	for (let index = 0; index < 5; index++) {
		try {
			const result = await rpc.invoke({ text: String(index), delayMs: 0 })
			outcomes.push(result.echoed)
		} catch (error) {
			outcomes.push(error instanceof Error ? error.message : 'unknown')
		}
	}
	return outcomes
}
