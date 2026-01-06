export {
	type DebugTopic,
	getDebugLogger,
	isDebugTopicEnabled,
	resolveDebugTopics,
} from '@pluxel/core/logger'

type PluxelHmrDebugTopics = {
	'pluxel:hmr': true
	'pluxel:hmr:*': true
	'pluxel:hmr:modules': true
	'pluxel:hmr:time': true
	'pluxel:hmr:time:entry': true
	'pluxel:hmr:warmup': true
	'pluxel:hmr:batch': true
	'pluxel:hmr:cache': true
	'pluxel:hmr:graph': true
	'pluxel:bundler': true
	'pluxel:ext:compile': true
}

declare module '@pluxel/core' {
	namespace Context {
		interface DebugTopics extends PluxelHmrDebugTopics {}
	}
}

declare module '@pluxel/context' {
	namespace Context {
		interface DebugTopics extends PluxelHmrDebugTopics {}
	}
}
