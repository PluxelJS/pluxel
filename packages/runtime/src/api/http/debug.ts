import type { Context as PluginContext, PluginNodeAddressSnapshot } from '@pluxel/core'

import { type AnyElysiaApp } from '../../services/http/elysia'
import { requireRouteCapability } from '../../runtime/capabilities'
import { pluginNodeAddressKey, pluginNodePhysicalKey } from '../../runtime/plugin-address'
import { RUNTIME_INTERNAL_API_BASE } from '../../web/paths'
import { debugSchemaSourceQuery } from './models'

const DEBUG_BASE = `${RUNTIME_INTERNAL_API_BASE}/debug`

interface PluginSchemaInfo {
	address: PluginNodeAddressSnapshot
	addressKey: string
	domId: string
	displayName: string
	rootExportName: string
	hasSchema: boolean
	hasSchemaSource: boolean
	fieldName?: string
	schemaSource?: string
}

function getPluginSchemaInfos(ctx: PluginContext): PluginSchemaInfo[] {
	const catalog = requireRouteCapability(ctx, 'catalog')
	const configMetadata = requireRouteCapability(ctx, 'configMetadata')
	const result: PluginSchemaInfo[] = []

	for (const entry of catalog.listRegistered()) {
		const config = configMetadata.getConfig(entry.address)
		result.push({
			address: entry.address,
			addressKey: pluginNodeAddressKey(entry.address),
			domId: `plugin-${pluginNodePhysicalKey(entry.address)}`,
			displayName: entry.displayName,
			rootExportName: entry.rootExportName,
			hasSchema: !!config,
			hasSchemaSource: !!config?.source,
			fieldName: config?.fieldName,
			schemaSource: config?.source,
		})
	}
	return result.sort((left, right) => left.addressKey.localeCompare(right.addressKey))
}

// 转义 HTML 特殊字符
function escapeHtml(str: string): string {
	return str
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

const STYLES = `
:root {
	--bg: #0d1117;
	--card-bg: #161b22;
	--border: #30363d;
	--text: #e6edf3;
	--text-muted: #8b949e;
	--accent: #58a6ff;
	--success: #3fb950;
	--warning: #d29922;
	--error: #f85149;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	background: var(--bg);
	color: var(--text);
	line-height: 1.6;
	padding: 24px;
}
.container { max-width: 1400px; margin: 0 auto; }
header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
header h1 { font-size: 22px; color: var(--accent); white-space: nowrap; }
.nav { display: flex; gap: 8px; flex-wrap: wrap; }
.nav a {
	color: var(--text-muted);
	text-decoration: none;
	padding: 6px 14px;
	border-radius: 6px;
	font-size: 14px;
	transition: all 0.15s;
}
.nav a:hover { background: var(--card-bg); color: var(--text); }
.nav a.active { background: var(--accent); color: var(--bg); }
h2 { font-size: 16px; margin: 20px 0 12px; color: var(--text); }
.card {
	background: var(--card-bg);
	border: 1px solid var(--border);
	border-radius: 8px;
	margin-bottom: 12px;
	overflow: hidden;
}
.card-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px 16px;
	background: rgba(0,0,0,0.2);
	border-bottom: 1px solid var(--border);
	cursor: pointer;
}
.card-header:hover { background: rgba(0,0,0,0.3); }
.card-title { font-size: 14px; font-weight: 600; }
.card-body { padding: 16px; }
.card-body.collapsed { display: none; }
.badges { display: flex; gap: 6px; }
.badge {
	display: inline-block;
	padding: 2px 8px;
	border-radius: 10px;
	font-size: 11px;
	font-weight: 500;
}
.badge-success { background: rgba(63, 185, 80, 0.15); color: var(--success); }
.badge-warning { background: rgba(210, 153, 34, 0.15); color: var(--warning); }
.badge-error { background: rgba(248, 81, 73, 0.15); color: var(--error); }
.badge-muted { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); }
pre {
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 12px;
	overflow-x: auto;
	font-size: 12px;
	line-height: 1.5;
	margin: 8px 0;
}
code { font-family: 'JetBrains Mono', 'SF Mono', Monaco, monospace; }
.field-label {
	font-size: 12px;
	color: var(--accent);
	font-weight: 600;
	margin-bottom: 4px;
	display: flex;
	align-items: center;
	gap: 8px;
}
.field-label .decorator { color: var(--warning); }
.schema-field { margin-bottom: 16px; }
.schema-field:last-child { margin-bottom: 0; }
.stats { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.stat {
	background: var(--card-bg);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 12px 20px;
	min-width: 100px;
}
.stat-value { font-size: 28px; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.empty { text-align: center; padding: 40px; color: var(--text-muted); }
.toolbar {
	display: flex;
	gap: 12px;
	margin-bottom: 16px;
	align-items: center;
	flex-wrap: wrap;
}
.search-box {
	flex: 1;
	min-width: 200px;
	max-width: 400px;
	padding: 8px 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--card-bg);
	color: var(--text);
	font-size: 14px;
}
.search-box:focus { outline: none; border-color: var(--accent); }
.filter-btn {
	padding: 8px 14px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--card-bg);
	color: var(--text-muted);
	font-size: 13px;
	cursor: pointer;
	transition: all 0.15s;
}
.filter-btn:hover { border-color: var(--text-muted); }
.filter-btn.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.quick-links { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.quick-link {
	display: block;
	padding: 16px;
	background: var(--card-bg);
	border: 1px solid var(--border);
	border-radius: 8px;
	text-decoration: none;
	color: inherit;
	transition: all 0.15s;
}
.quick-link:hover { border-color: var(--accent); transform: translateY(-2px); }
.quick-link h3 { font-size: 14px; color: var(--text); margin-bottom: 4px; }
.quick-link p { font-size: 12px; color: var(--text-muted); }
.copy-btn {
	padding: 2px 8px;
	font-size: 11px;
	border: 1px solid var(--border);
	border-radius: 4px;
	background: transparent;
	color: var(--text-muted);
	cursor: pointer;
}
.copy-btn:hover { background: var(--border); }
`

const SCRIPTS = `
function toggleCard(el) {
	const body = el.nextElementSibling;
	body.classList.toggle('collapsed');
	el.querySelector('.toggle-icon').textContent = body.classList.contains('collapsed') ? '+' : '-';
}

function filterPlugins() {
	const search = document.getElementById('search').value.toLowerCase();
	const showOnlyWithSource = document.getElementById('filter-source')?.classList.contains('active');
	const showOnlyWithSchema = document.getElementById('filter-schema')?.classList.contains('active');

	document.querySelectorAll('.plugin-card').forEach(card => {
		const name = card.dataset.name.toLowerCase();
		const hasSchema = card.dataset.hasSchema === 'true';
		const hasSource = card.dataset.hasSource === 'true';

		let show = name.includes(search);
		if (showOnlyWithSource && !hasSource) show = false;
		if (showOnlyWithSchema && !hasSchema) show = false;

		card.style.display = show ? '' : 'none';
	});
}

function toggleFilter(btn) {
	btn.classList.toggle('active');
	filterPlugins();
}

function expandAll() {
	document.querySelectorAll('.card-body').forEach(el => el.classList.remove('collapsed'));
	document.querySelectorAll('.toggle-icon').forEach(el => el.textContent = '-');
}

function collapseAll() {
	document.querySelectorAll('.card-body').forEach(el => el.classList.add('collapsed'));
	document.querySelectorAll('.toggle-icon').forEach(el => el.textContent = '+');
}

function copyCode(btn, fieldId) {
	const code = document.getElementById(fieldId).textContent;
	navigator.clipboard.writeText(code).then(() => {
		const orig = btn.textContent;
		btn.textContent = 'Copied!';
		setTimeout(() => btn.textContent = orig, 1500);
	});
}
`

function layout(title: string, content: string, activeNav?: string) {
	const navItems = [
		{ href: `${DEBUG_BASE}`, label: 'Overview', key: 'overview' },
		{ href: `${DEBUG_BASE}/schema-source`, label: 'Schema Source', key: 'schema-source' },
	]

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title} - Pluxel Debug</title>
	<style>${STYLES}</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Pluxel Debug</h1>
			<nav class="nav">
				${navItems
					.map(
						(item) =>
							`<a href="${item.href}" class="${activeNav === item.key ? 'active' : ''}">${item.label}</a>`,
					)
					.join('')}
			</nav>
		</header>
		${content}
	</div>
	<script>${SCRIPTS}</script>
</body>
</html>`
}

function renderSchemaSource(plugin: PluginSchemaInfo) {
	const fieldId = `code-${pluginNodePhysicalKey(plugin.address)}`
	const formatted = escapeHtml(plugin.schemaSource ?? '')

	return `
		<div class="schema-field">
			<div class="field-label">
				<span class="decorator">configs.use</span>
				<span>${escapeHtml(plugin.fieldName ?? 'config')}</span>
				<button class="copy-btn" onclick="copyCode(this, '${fieldId}')">Copy</button>
			</div>
			<pre><code id="${fieldId}">${formatted}</code></pre>
		</div>
	`
}

function renderPluginCard(plugin: PluginSchemaInfo, expanded = false) {
	return `
		<div id="${plugin.domId}" class="card plugin-card" data-name="${escapeHtml(`${plugin.displayName} ${plugin.rootExportName} ${plugin.addressKey}`)}" data-has-schema="${plugin.hasSchema}" data-has-source="${plugin.hasSchemaSource}">
			<div class="card-header" onclick="toggleCard(this)">
				<span class="card-title">${escapeHtml(plugin.displayName)} <span style="color: var(--text-muted);">${escapeHtml(plugin.rootExportName)}</span></span>
				<div style="display: flex; align-items: center; gap: 12px;">
					<div class="badges">
						${plugin.hasSchema ? '<span class="badge badge-success">Schema</span>' : '<span class="badge badge-muted">No Schema</span>'}
						${plugin.hasSchemaSource ? '<span class="badge badge-success">Source</span>' : '<span class="badge badge-warning">No Source</span>'}
						${plugin.hasSchema ? '<span class="badge badge-muted">1 object schema</span>' : ''}
					</div>
					<span class="toggle-icon" style="font-family: monospace; color: var(--text-muted);">${expanded ? '-' : '+'}</span>
				</div>
			</div>
			<div class="card-body ${expanded ? '' : 'collapsed'}">
				${
					plugin.schemaSource
						? renderSchemaSource(plugin)
						: '<p style="color: var(--text-muted); font-size: 13px;">No schema source extracted for this plugin.</p>'
				}
			</div>
		</div>
	`
}

export const debugRoutes = (app: AnyElysiaApp) =>
	app.group('/debug', (debug) =>
		debug
			.get('', ({ pluginCtx, set }) => {
				const plugins = getPluginSchemaInfos(pluginCtx)
				const withSchema = plugins.filter((p) => p.hasSchema).length
				const withSource = plugins.filter((p) => p.hasSchemaSource).length

				const content = `
			<div class="stats">
				<div class="stat">
					<div class="stat-value">${plugins.length}</div>
					<div class="stat-label">Plugins</div>
				</div>
				<div class="stat">
					<div class="stat-value">${withSchema}</div>
					<div class="stat-label">With Schema</div>
				</div>
				<div class="stat">
					<div class="stat-value">${withSource}</div>
					<div class="stat-label">With Source</div>
				</div>
			</div>

				<h2>Quick Links</h2>
				<div class="quick-links">
					<a href="${DEBUG_BASE}/schema-source" class="quick-link">
						<h3>Schema Source Inspector</h3>
						<p>View and verify extracted schema source code for all plugins</p>
					</a>
					<a href="${DEBUG_BASE}/schema-source?filter=source" class="quick-link">
						<h3>Plugins with Source</h3>
						<p>Filter to show only plugins with extracted schema source</p>
					</a>
					<a href="${DEBUG_BASE}/json/schemas" class="quick-link">
						<h3>JSON API</h3>
						<p>Get raw schema data as JSON for debugging</p>
					</a>
				</div>

			${
				plugins.length > 0
					? `
				<h2>All Plugins</h2>
				<div class="quick-links">
						${plugins
							.map(
								(p) => `
							<a href="${DEBUG_BASE}/schema-source#${p.domId}" class="quick-link">
								<h3>${escapeHtml(p.displayName)}</h3>
								<p>${escapeHtml(p.rootExportName)} · ${p.hasSchemaSource ? '1 object schema source' : 'No schema source'}</p>
							</a>
						`,
							)
							.join('')}
				</div>
			`
					: ''
			}
		`
				set.headers['content-type'] = 'text/html; charset=utf-8'
				return layout('Overview', content, 'overview')
			})
			.get(
				'/schema-source',
				({ pluginCtx, query, set }) => {
					const plugins = getPluginSchemaInfos(pluginCtx)
					const filter = query.filter
					const search = query.q || ''

					let filtered = plugins
					if (filter === 'source') {
						filtered = plugins.filter((p) => p.hasSchemaSource)
					} else if (filter === 'schema') {
						filtered = plugins.filter((p) => p.hasSchema)
					}
					if (search) {
						const q = search.toLowerCase()
						filtered = filtered.filter((p) =>
							`${p.displayName} ${p.rootExportName} ${p.addressKey}`.toLowerCase().includes(q),
						)
					}

					const withSource = plugins.filter((p) => p.hasSchemaSource).length

					const content = `
			<div class="stats">
				<div class="stat">
					<div class="stat-value">${plugins.length}</div>
					<div class="stat-label">Total</div>
				</div>
				<div class="stat">
					<div class="stat-value">${withSource}</div>
					<div class="stat-label">With Source</div>
				</div>
				<div class="stat">
					<div class="stat-value">${filtered.length}</div>
					<div class="stat-label">Showing</div>
				</div>
			</div>

			<div class="toolbar">
				<input type="text" id="search" class="search-box" placeholder="Search plugins..." value="${escapeHtml(search)}" oninput="filterPlugins()">
				<button id="filter-source" class="filter-btn ${filter === 'source' ? 'active' : ''}" onclick="toggleFilter(this)">Has Source</button>
				<button id="filter-schema" class="filter-btn ${filter === 'schema' ? 'active' : ''}" onclick="toggleFilter(this)">Has Schema</button>
				<button class="filter-btn" onclick="expandAll()">Expand All</button>
				<button class="filter-btn" onclick="collapseAll()">Collapse All</button>
			</div>

			${filtered.length === 0 ? '<div class="empty">No plugins match the current filter</div>' : filtered.map((p) => renderPluginCard(p, filtered.length === 1)).join('')}
		`
					set.headers['content-type'] = 'text/html; charset=utf-8'
					return layout('Schema Source', content, 'schema-source')
				},
				{
					query: debugSchemaSourceQuery,
				},
			)
			.get('/json/schemas', ({ pluginCtx }) => {
				return getPluginSchemaInfos(pluginCtx)
			}),
	)
