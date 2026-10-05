const policy = Object.freeze({
	usePolling: true,
	interval: 100,
	binaryInterval: 100,
	atomic: true,
})

/** Observe the final bytes after rapid repairs without Chokidar's lossy 50ms change throttle. */
export function hostFileWatchOptions(): typeof policy {
	// Chokidar gives these process variables precedence over explicit watcher options.
	const polling = process.env.CHOKIDAR_USEPOLLING
	if (polling !== undefined && !['true', '1'].includes(polling.toLowerCase()))
		throw new TypeError(
			`[host-vite] CHOKIDAR_USEPOLLING=${JSON.stringify(polling)} conflicts with reliable file updates; unset it or use true`,
		)
	const interval = process.env.CHOKIDAR_INTERVAL
	if (interval !== undefined && interval !== String(policy.interval))
		throw new TypeError(
			`[host-vite] CHOKIDAR_INTERVAL=${JSON.stringify(interval)} conflicts with the ${policy.interval}ms file update interval; unset it or use ${policy.interval}`,
		)
	return policy
}
