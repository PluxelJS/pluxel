import { createMarketplaceData, Marketplace } from '@pluxel/plugin-package-manager/marketplace'
import { createRoot } from 'react-dom/client'
import './page.css'

const root = document.getElementById('root')
if (!root) throw new Error('Market page root is missing')

const marketUrl = import.meta.env.VITE_MARKET_URL || window.location.origin
const data = createMarketplaceData(marketUrl)

createRoot(root).render(
	<main className="plx-package-ui market-page" data-color-scheme="auto">
		<header className="market-page-header">
			<span className="market-page-brand">Pluxel</span>
			<span>Plugin Market</span>
		</header>
		<Marketplace data={data} colorScheme="auto" />
	</main>,
)
