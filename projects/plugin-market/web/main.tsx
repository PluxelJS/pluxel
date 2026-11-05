import { Marketplace } from '@pluxel/plugin-package-manager/marketplace'
import { createRoot } from 'react-dom/client'
import { createMarketplaceData } from './market-data'
import './page.css'

const root = document.getElementById('root')
if (!root) throw new Error('Market page root is missing')

const marketUrl = import.meta.env.VITE_MARKET_URL || window.location.origin
const data = createMarketplaceData(marketUrl)

createRoot(root).render(
	<main className="market-page">
		<header className="market-page-header">
			<span className="market-page-brand">Pluxel</span>
			<span>Plugin Market</span>
		</header>
		<Marketplace data={data} colorScheme="light" />
	</main>,
)
