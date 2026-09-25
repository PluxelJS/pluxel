interface ToyRpc {
	invoke(input: { text: string; delayMs: number }): Promise<{ echoed: string }>
}

async function run(rpc: ToyRpc) {
	return await Promise.all(
		['a', 'b', 'c'].map(async (text) => {
			try {
				const result = await rpc.invoke({ text, delayMs: 700 })
				return result.echoed
			} catch (error) {
				return error instanceof Error ? error.message : 'unknown'
			}
		}),
	)
}
