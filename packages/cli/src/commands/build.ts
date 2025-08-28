import { Command } from 'commander'

export function buildCommand() {
	return new Command('build')
		.description('Build current project')
		.option('--watch', 'watch mode', false)
		.action(async (opts) => {
			// 这里放你现有的 build 流程（esbuild/tsup/rollup/x）
			console.log('building...', opts)
		})
}
