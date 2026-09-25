async function run() {
	const chunks: Uint8Array[] = []
	for (;;) chunks.push(new Uint8Array(4 * 1024 * 1024).fill(1))
}
