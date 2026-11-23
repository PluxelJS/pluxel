import { Link } from 'fumapress/client'
import { MarketCatalog } from '../components/market-catalog'

function developmentMarketUrl() {
	const docs = process.env.PITCHFORK_URL
	if (docs) {
		const origin = new URL(docs)
		if (origin.hostname.startsWith('docs.')) {
			origin.hostname = origin.hostname.replace(/^docs\./, 'market.')
			return origin.origin
		}
	}
	return 'http://127.0.0.1:8787'
}

export default function MarketPage() {
	const url =
		import.meta.env.VITE_MARKET_URL || (import.meta.env.DEV ? developmentMarketUrl() : undefined)
	return (
		<>
			<title>插件市场 | Pluxel</title>
			<meta name="description" content="浏览 Pluxel 插件，查看源码、使用说明和发行版本。" />
			<main className="mx-auto w-full max-w-[1440px] px-4 py-5 [--pm-sticky-top:--spacing(14)] sm:px-8">
				<h1 className="mb-4 text-2xl font-semibold tracking-tight">插件市场</h1>
				{url ? (
					<MarketCatalog url={url} />
				) : (
					<p className="text-fd-muted-foreground">
						此文档站尚未配置公开市场目录。{' '}
						<Link className="text-fd-primary underline" href="/docs/plugins/package-manager">
							查看市场接入说明
						</Link>
					</p>
				)}
			</main>
		</>
	)
}
