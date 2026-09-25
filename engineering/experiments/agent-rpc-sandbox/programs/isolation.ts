declare const require: (name: string) => any
declare const process: {
	pid: number
	env: Record<string, string | undefined>
	kill(pid: number, signal: number): void
}

async function run() {
	const fs = require('node:fs')
	const childProcess = require('node:child_process')
	const hostCanary = process.env.RPC_HOST_CANARY!
	const hostPid = Number(process.env.RPC_HOST_PID)
	let hostProcessVisible = true
	try {
		process.kill(hostPid, 0)
	} catch {
		hostProcessVisible = false
	}
	let networkReachable = true
	try {
		await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(500) })
	} catch {
		networkReachable = false
	}
	const child = childProcess.execFileSync(
		'node',
		['-e', 'process.stdout.write(String(process.pid))'],
		{ encoding: 'utf8' },
	)
	return {
		hostFileVisible: fs.existsSync(hostCanary),
		mountedCanaryVisible: fs.existsSync('/rpc/host-canary.txt'),
		hostProcessVisible,
		networkReachable,
		containerPid: process.pid,
		childPid: Number(child),
		memoryMax: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
		pidsMax: fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(),
	}
}
