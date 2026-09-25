interface ToyRpc {
	invoke(input: { text: string; delayMs: number }): Promise<{ echoed: string }>
}

declare const process: { exit(code: number): never }

async function run(rpc: ToyRpc) {
	void rpc.invoke({ text: 'committed', delayMs: 700 })
	await new Promise((resolve) => setTimeout(resolve, 100))
	process.exit(0)
}
