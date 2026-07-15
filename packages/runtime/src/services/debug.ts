type PluxelRuntimeDebugTopics = {
	'hmr:modules': true
	'hmr:fetch': true
	'hmr:time:entry': true
	'hmr:warmup': true
	'hmr:batch': true
	'hmr:cache': true
	'hmr:graph': true
	bundler: true
	'workbench:compile': true
}

declare module '@pluxel/core' {
	namespace Context {
		interface DebugTopics extends PluxelRuntimeDebugTopics {}
	}
}
