interface ToyRpc {
	invoke(input: { text: string; delayMs: number }): Promise<{ echoed: string }>
}

async function run(rpc: ToyRpc) {
	return await rpc.invoke({ text: 'hello', delayMs: 700 })
}
