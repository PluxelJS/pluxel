try {
	if (process.argv[2] === 'standalone') {
		await import('./app.mjs')
	} else {
		const { runHostApplication } = await import('@pluxel/host')
		const { elysiaSharedPackages } = await import('@pluxel/services/sources')
		await runHostApplication('./app.mjs', {
			startup: { root: import.meta.dirname, mode: 'production', env: process.env, bindings: {} },
			sharedPackages: elysiaSharedPackages,
		})
	}
} catch (error) {
	console.error(`STARTUP_ERROR ${error.code}`)
	console.error(error)
	process.exitCode = 1
}
