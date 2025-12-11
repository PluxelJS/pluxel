// Web API（Rest/RPC/SSE）
export * from '../../../hmr/src/web/web'
// React 封装：全局客户端 Provider + hook
export {
	HmrWebClientProvider,
	useHmrWebClient,
	useSseClient,
	usePluginSse,
	useSharedSseClient,
} from '../../../hmr/src/web/react'
