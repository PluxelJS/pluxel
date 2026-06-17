import { createGraphDataStore } from '@gqlens/core'
import { GQLensProvider, useMutation } from '@gqlens/react'
import { useMemo, useState } from 'react'
import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { api, defineInvalidation, useQuery } from '../gqlens/accessor'
import { graphqlFetcher } from './graphql-fetcher'
import './styles.css'

const summaryInvalidation = defineInvalidation((q) => q.summary.revenue)
const ordersInvalidation = defineInvalidation((q) => q.orders.ids)

function App() {
	const store = useMemo(() => createGraphDataStore(), [])
	const config = useMemo(
		() => ({
			fetcher: graphqlFetcher,
			store,
			query: { policy: 'cache-and-network' as const, ttl: 30_000 },
		}),
		[store],
	)

	return (
		<GQLensProvider config={config}>
			<CommercialConsole />
		</GQLensProvider>
	)
}

function CommercialConsole() {
	const q = useQuery()
	const approveOrder = useMutation(api.mutation.approveOrder)
	const updateOrderAmount = useMutation(api.orderAmount.update)
	const setCustomerHealth = useMutation(api.customerHealth.set)
	const [selectedOrderId, setSelectedOrderId] = useState('o_1001')
	const [amountDraft, setAmountDraft] = useState('132000')
	const [healthDraft, setHealthDraft] = useState('94')
	const [status, setStatus] = useState('ready')

	const customerIds = q.customers.ids ?? []
	const orderIds = q.orders.ids ?? []
	const reviewOrderIds = q.ordersByStatus({ status: 'review' }).ids ?? []
	const selectedOrder = q.order({ id: selectedOrderId })
	const selectedCustomerId = selectedOrder.customerId
	const selectedCustomer = selectedCustomerId ? q.customer({ id: selectedCustomerId }) : undefined

	async function handleApprove() {
		setStatus('approving')
		await approveOrder(
			{ id: selectedOrderId },
			{ invalidates: [summaryInvalidation, ordersInvalidation] },
		)
		setStatus('approved')
	}

	async function handleAmountUpdate() {
		setStatus('updating amount')
		await updateOrderAmount(
			{ id: selectedOrderId, amount: Number(amountDraft) },
			{ invalidates: [summaryInvalidation, ordersInvalidation] },
		)
		setStatus('amount updated')
	}

	async function handleHealthUpdate() {
		if (!selectedCustomerId) return
		setStatus('updating health')
		await setCustomerHealth(
			{ id: selectedCustomerId, score: Number(healthDraft) },
			{
				invalidates: [
					{
						kind: 'entity',
						ref: { type: 'Customer', id: selectedCustomerId },
						paths: [[{ field: 'healthScore' }]],
					},
				],
			},
		)
		setStatus('health updated')
	}

	return (
		<main className="shell">
			<header className="topbar">
				<div>
					<p className="eyebrow">Static plugin commercial ops</p>
					<h1>Revenue Control Desk</h1>
				</div>
				<div className="status-pill">{q.loading ? 'syncing' : status}</div>
			</header>

			<section className="metrics">
				<Metric label="Revenue" value={currency(q.summary.revenue)} />
				<Metric label="Gross Margin" value={currency(q.summary.margin)} />
				<Metric label="Open Orders" value={String(q.summary.openOrders ?? '-')} />
				<Metric label="Approved" value={String(q.summary.approvedOrders ?? '-')} />
			</section>

			<section className="workspace">
				<div className="panel customer-panel">
					<header>
						<h2>Accounts</h2>
						<span>{customerIds.length} customers</span>
					</header>
					<ul className="rows">
						{customerIds.map((id) => {
							const customer = q.customer({ id })
							return (
								<li key={id}>
									<strong>{customer.name ?? id}</strong>
									<span>{customer.owner ?? 'unassigned'}</span>
									<span>{customer.tier ?? 'tier'} / {customer.region ?? 'region'}</span>
									<em>{customer.healthScore ?? '-'} health</em>
								</li>
							)
						})}
					</ul>
				</div>

				<div className="panel order-panel">
					<header>
						<h2>Orders</h2>
						<span>{reviewOrderIds.length} in review</span>
					</header>
					<ul className="order-list">
						{orderIds.map((id) => {
							const order = q.order({ id })
							return (
								<li key={id}>
									<button
										type="button"
										className={id === selectedOrderId ? 'selected' : ''}
										onClick={() => {
											setSelectedOrderId(id)
											setAmountDraft(String(order.amount ?? ''))
										}}
									>
										<span>
											<strong>{order.sku ?? id}</strong>
											<small>{customerLabel(q, order.customerId)}</small>
										</span>
										<span className={`badge badge-${order.status ?? 'draft'}`}>
											{order.status ?? 'draft'}
										</span>
										<em>{currency(order.amount)}</em>
									</button>
								</li>
							)
						})}
					</ul>
				</div>

				<div className="panel action-panel">
					<header>
						<h2>Controls</h2>
						<span>{selectedOrderId}</span>
					</header>
					<div className="detail">
						<strong>{selectedOrder.sku ?? 'Select an order'}</strong>
						<span>{selectedCustomer?.name ?? 'Customer loading'}</span>
						<span>{percent(selectedOrder.margin)} margin</span>
					</div>
					<label>
						<span>Order amount</span>
						<input
							value={amountDraft}
							inputMode="numeric"
							onChange={(event) => setAmountDraft(event.currentTarget.value)}
						/>
					</label>
					<div className="button-row">
						<button type="button" onClick={() => void handleAmountUpdate()}>
							Update amount
						</button>
						<button type="button" onClick={() => void handleApprove()}>
							Approve order
						</button>
					</div>
					<label>
						<span>Customer health</span>
						<input
							value={healthDraft}
							inputMode="numeric"
							onChange={(event) => setHealthDraft(event.currentTarget.value)}
						/>
					</label>
					<button type="button" className="secondary" onClick={() => void handleHealthUpdate()}>
						Set health score
					</button>
				</div>
			</section>
		</main>
	)
}

function Metric(props: { readonly label: string; readonly value: string }) {
	return (
		<div className="metric">
			<span>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	)
}

function customerLabel(q: ReturnType<typeof useQuery>, customerId: string | undefined): string {
	if (!customerId) return 'loading customer'
	return q.customer({ id: customerId }).name ?? customerId
}

function currency(value: number | undefined): string {
	if (typeof value !== 'number') return '-'
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 0,
	}).format(value)
}

function percent(value: number | undefined): string {
	if (typeof value !== 'number') return '-'
	return new Intl.NumberFormat('en-US', {
		style: 'percent',
		maximumFractionDigits: 0,
	}).format(value)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'static-commercial-console',
			priority: 80,
			meta: { label: 'Commercial' },
			render: () => <App />,
		},
		{
			point: ExtensionPoints.PluginInfo,
			id: 'static-commercial-info',
			priority: 40,
			render: () => (
				<div className="plugin-info">
					<strong>Static commercial backend</strong>
					<span>GraphQL is mounted by the static Pluxel plugin route.</span>
				</div>
			),
		},
	],
	routes: [
		{
			definition: {
				path: '/commercial',
				title: 'Static Commercial',
				addToNav: true,
				navPriority: 70,
			},
			render: () => <App />,
		},
	],
})
