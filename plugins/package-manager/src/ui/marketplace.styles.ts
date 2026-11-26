import { packageThemeStyles } from './package-theme.ts'

export const marketplaceStyles =
	packageThemeStyles +
	`
.plx-marketplace {
  container-type: inline-size; color: var(--pm-ink);
  font: 400 14px/1.55 var(--pm-font); min-width: 0; text-align: left;
}
.plx-marketplace *, .plx-marketplace *::before, .plx-marketplace *::after { box-sizing: border-box; }
.plx-marketplace [hidden] { display: none !important; }
.plx-marketplace h2, .plx-marketplace h3, .plx-marketplace p, .plx-marketplace dl, .plx-marketplace dd { margin: 0; }
.plx-marketplace h2 { font-size: 26px; line-height: 1.25; letter-spacing: -.035em; font-weight: 650; overflow-wrap: anywhere; }
.plx-marketplace h3 { font-size: 15px; line-height: 1.4; font-weight: 650; overflow-wrap: anywhere; }
.plx-marketplace a { color: var(--pm-accent); text-decoration: none; text-underline-offset: 3px; }
.plx-marketplace a:hover { text-decoration: underline; }
.plx-marketplace button, .plx-marketplace input, .plx-marketplace select { font: inherit; }
.plx-marketplace button, .plx-marketplace a { -webkit-tap-highlight-color: transparent; }
.plx-marketplace button { cursor: pointer; }
.plx-marketplace button:disabled { cursor: default; opacity: 1; }
.plx-marketplace :is(button, a, input, select, summary):focus-visible { outline: 2px solid var(--pm-accent); outline-offset: 3px; }
.plx-marketplace svg { flex-shrink: 0; vertical-align: middle; }
.plx-marketplace code { font: 12px/1.55 var(--pm-mono); overflow-wrap: anywhere; }
.plx-marketplace .pm-stack { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.plx-marketplace .pm-inline, .plx-marketplace .pm-between { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; }
.plx-marketplace .pm-between { justify-content: space-between; }
.plx-marketplace .pm-muted { color: var(--pm-muted); }
.plx-marketplace .pm-small { font-size: 13px; }
.plx-marketplace .pm-button { display: inline-flex; justify-content: center; align-items: center; gap: 7px; min-height: 36px; padding: 7px 12px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-canvas); color: var(--pm-ink); font-size: 13px; line-height: 1.3; font-weight: 550; text-decoration: none; transition: background .15s, border-color .15s; }
.plx-marketplace .pm-button:hover:not(:disabled) { background: var(--pm-surface); border-color: var(--pm-muted); }
.plx-marketplace .pm-primary { background: var(--pm-filled); border-color: var(--pm-filled); color: var(--pm-on-filled); }
.plx-marketplace .pm-primary:hover:not(:disabled) { background: var(--pm-filled); border-color: var(--pm-filled); filter: brightness(.93); }
.plx-marketplace .pm-quiet { background: transparent; border-color: transparent; color: var(--pm-muted); }
.plx-marketplace .pm-dependency-link { min-height: 24px; appearance: none; background: transparent; border: 0; color: var(--pm-accent); cursor: pointer; padding: 2px 0; text-align: start; overflow-wrap: anywhere; text-decoration: underline; text-underline-offset: 3px; }
.plx-marketplace .pm-link { background: transparent; border-color: transparent; color: var(--pm-accent); padding-inline: 0; }
.plx-marketplace .pm-link:hover:not(:disabled) { background: transparent; border-color: transparent; text-decoration: underline; text-underline-offset: 3px; }
.plx-marketplace .pm-catalog { display: grid; grid-template-columns: clamp(160px, 16%, 196px) minmax(0, 1fr); grid-template-rows: auto auto 1fr; grid-template-areas: "filters search" "filters status" "filters results"; column-gap: clamp(12px, 1.5cqi, 20px); align-items: start; min-width: 0; }
.plx-marketplace .pm-toolbar { grid-area: search; display: flex; align-items: center; gap: 8px; min-width: 0; }
.plx-marketplace .pm-catalog-results { grid-area: results; min-width: 0; }
.plx-marketplace .pm-search { position: relative; flex: 1; min-width: 0; }
.plx-marketplace label { display: block; margin-bottom: 7px; font-size: 12px; color: var(--pm-muted); font-weight: 550; }
.plx-marketplace input, .plx-marketplace select { display: block; width: 100%; min-width: 0; min-height: 36px; border: 1px solid var(--pm-border); border-radius: var(--pm-radius); padding: 6px 9px; color: var(--pm-ink); background: var(--pm-canvas); font-size: 13px; }
.plx-marketplace input::placeholder { color: var(--pm-muted); }
.plx-marketplace :is(input:not([type="checkbox"], [type="radio"]), select) { border-color: var(--pm-control); }
.plx-marketplace .pm-search input { padding-inline-end: 36px; }
.plx-marketplace .pm-search input::-webkit-search-cancel-button { display: none; }
.plx-marketplace .pm-clear-search { position: absolute; inset-block: 4px; inset-inline-end: 4px; width: 28px; padding: 0; color: var(--pm-muted); border: 0; border-radius: 5px; background: transparent; }
.plx-marketplace .pm-clear-search:hover { background: var(--pm-surface); color: var(--pm-ink); }
.plx-marketplace .pm-button:disabled { color: var(--pm-muted); border-color: var(--pm-border); background: var(--pm-surface); }
.plx-marketplace .pm-button.pm-compact-filters { display: none; }
.plx-marketplace .pm-filter-sidebar { grid-area: filters; position: sticky; top: var(--pm-sticky-top, 0px); min-width: 0; padding: 4px 14px 4px 0; max-height: max(260px, calc(100dvh - 100px)); overflow-y: auto; scrollbar-width: thin; border-inline-end: 1px solid var(--pm-border); }
.plx-marketplace .pm-sidebar-title { margin-block: 0 6px; color: var(--pm-ink); font-size: 15px; }
.plx-marketplace .pm-facet { margin: 0; padding: 7px 0; border-block-start: 1px solid var(--pm-border); }
.plx-marketplace .pm-facet:first-of-type { border-block-start: 0; }
.plx-marketplace .pm-facet > summary { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 2px; border-radius: 4px; color: var(--pm-ink); font-size: 12px; font-weight: 650; cursor: pointer; list-style: none; }
.plx-marketplace .pm-facet > summary::-webkit-details-marker { display: none; }
.plx-marketplace .pm-facet > summary::after { content: ''; width: 6px; height: 6px; margin-inline-end: 3px; border: solid var(--pm-muted); border-width: 0 1px 1px 0; transform: rotate(45deg); }
.plx-marketplace .pm-facet[open] > summary::after { transform: translateY(2px) rotate(225deg); }
.plx-marketplace .pm-facet > summary:focus-visible { outline: 2px solid var(--pm-accent); outline-offset: -1px; }
.plx-marketplace .pm-filter-options { min-width: 0; padding-block-start: 3px; }
.plx-marketplace .pm-filter-options > input { min-height: 30px; margin-block: 2px 3px; font-size: 12px; }
.plx-marketplace .pm-filter-options > .pm-muted { padding-inline: 2px; }
.plx-marketplace label.pm-filter-option { display: flex; align-items: center; gap: 7px; min-height: 27px; min-width: 0; margin: 0; padding: 2px 3px; border-radius: 4px; color: var(--pm-ink); font-size: 12px; font-weight: 400; cursor: pointer; }
.plx-marketplace .pm-filter-option:hover, .plx-marketplace .pm-filter-option:focus-within { background: var(--pm-surface); }
.plx-marketplace .pm-filter-option input { flex: none; width: 14px; height: 14px; min-height: 0; margin: 0; padding: 0; accent-color: var(--pm-accent); }
.plx-marketplace .pm-filter-option .pm-avatar { width: 16px; height: 16px; }
.plx-marketplace .pm-side-more { border: 0; border-radius: 4px; padding: 3px; color: var(--pm-accent); background: transparent; font-size: 12px; text-align: start; }
.plx-marketplace .pm-side-more:hover { text-decoration: underline; }
.plx-marketplace .pm-filter-error { display: grid; justify-items: start; gap: 2px; color: var(--pm-error); }
.plx-marketplace .pm-option-count { margin-inline-start: auto; color: var(--pm-muted); font-variant-numeric: tabular-nums; }
.plx-marketplace .pm-catalog-count { white-space: nowrap; font-variant-numeric: tabular-nums; }
.plx-marketplace .pm-selected-filters { grid-area: status; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; padding-block-start: 6px; }
.plx-marketplace .pm-selected-filters .pm-button { min-height: 24px; padding: 2px 5px; font-size: 12px; }
.plx-marketplace .pm-badge { display: inline-flex; flex: none; align-items: center; white-space: nowrap; border-radius: 5px; padding: 2px 5px; background: var(--pm-surface); color: var(--pm-muted); font-size: 12px; line-height: 1.4; font-weight: 550; }
.plx-marketplace :is(.pm-official, .pm-verified, .pm-installed) { background: var(--pm-positive-soft); color: var(--pm-positive); }
.plx-marketplace .pm-package-status { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; max-width: 100%; }
.plx-marketplace .pm-package-status > .pm-badge { max-width: 100%; }
.plx-marketplace .pm-update { background: var(--pm-accent-soft); color: var(--pm-accent); }
.plx-marketplace .pm-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.plx-marketplace .pm-tags:empty { display: none; }
.plx-marketplace .pm-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid transparent; padding: 3px 7px; border-radius: 5px; font: inherit; font-size: 12px; line-height: 1.4; background: var(--pm-surface); color: var(--pm-muted); }
.plx-marketplace button.pm-chip:hover { border-color: var(--pm-border); color: var(--pm-ink); }
.plx-marketplace .pm-chip.pm-applied-filter { max-width: min(165px, 100%); color: var(--pm-accent); background: var(--pm-accent-soft); }
.plx-marketplace .pm-category { background: var(--pm-accent-soft); color: var(--pm-accent); }
.plx-marketplace .pm-results { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 246px), 1fr)); gap: 8px; list-style: none; padding: 0; margin: 8px 0 0; }
.plx-marketplace .pm-package-card { position: relative; isolation: isolate; display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 9px 11px 7px; border: 1px solid var(--pm-border); border-radius: var(--pm-radius); background: var(--pm-canvas); }
.plx-marketplace .pm-package-card:hover, .plx-marketplace .pm-package-card:focus-within { border-color: var(--pm-muted); background: var(--pm-surface); }
.plx-marketplace .pm-truncate { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plx-marketplace .pm-package-heading { display: flex; align-items: center; gap: 6px; min-width: 0; }
.plx-marketplace .pm-text-action { min-width: 0; border: 0; border-radius: 3px; padding: 0; text-align: start; background: transparent; color: var(--pm-ink); }
.plx-marketplace .pm-text-action:hover { color: var(--pm-accent); text-decoration: underline; text-underline-offset: 2px; }
.plx-marketplace .pm-text-action[aria-pressed="true"] { color: var(--pm-accent); }
.plx-marketplace .pm-package-name { font-size: 15px; font-weight: 680; line-height: 1.45; letter-spacing: -.018em; }
.plx-marketplace .pm-scope { color: var(--pm-muted); font-weight: 500; }
.plx-marketplace .pm-package-name::after { content: ''; position: absolute; inset: -1px; z-index: 1; border-radius: 8px; }
.plx-marketplace .pm-package-name:focus-visible { outline: none; }
.plx-marketplace .pm-package-name:focus-visible::after { outline: 2px solid var(--pm-accent); outline-offset: 3px; }
.plx-marketplace .pm-package-card :is(a, button:not(.pm-package-name)) { position: relative; z-index: 2; }
.plx-marketplace .pm-summary { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--pm-muted); font-size: 13px; line-height: 1.45; }
.plx-marketplace .pm-author { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; vertical-align: middle; }
.plx-marketplace .pm-avatar { flex: none; border-radius: 50%; object-fit: cover; }
.plx-marketplace :is(.pm-card-author, .pm-owner-link) { color: var(--pm-accent); }
.plx-marketplace .pm-card-author { flex: 0 1 auto; max-width: 100%; min-width: 0; min-height: 20px; font-size: 12px; }
.plx-marketplace .pm-card-author .pm-avatar { width: 17px; height: 17px; }
.plx-marketplace .pm-owner-unknown { color: var(--pm-muted); font-size: 12px; }
.plx-marketplace .pm-card-byline, .plx-marketplace .pm-card-metadata { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 9px; min-width: 0; }
.plx-marketplace .pm-card-byline { margin-block-start: auto; }
.plx-marketplace .pm-card-tags { display: flex; gap: 3px; min-width: 0; max-width: 100%; }
.plx-marketplace .pm-card-tags .pm-chip { padding: 1px 5px; }
.plx-marketplace .pm-card-more-tags { flex: none; }
.plx-marketplace .pm-card-byline .pm-repository { font-size: 12px; }
.plx-marketplace .pm-card-byline .pm-repository a { color: var(--pm-muted); }
.plx-marketplace .pm-card-footer { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; padding-block-start: 4px; border-top: 1px solid var(--pm-border); color: var(--pm-muted); font-size: 12px; }
.plx-marketplace .pm-card-origin, .plx-marketplace .pm-card-version { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.plx-marketplace .pm-card-origin { flex: 1 1 85px; }
.plx-marketplace .pm-card-origin > span + span { padding-inline-start: 6px; border-inline-start: 1px solid var(--pm-border); }
.plx-marketplace .pm-card-version { max-width: 100%; }
.plx-marketplace .pm-card-version > code { color: var(--pm-ink); font-size: 12px; }
.plx-marketplace .pm-no-release { flex: none; }
.plx-marketplace .pm-repository { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; font-size: 12px; }
.plx-marketplace .pm-repository a::after { content: '↗'; padding-inline-start: 2px; font-family: system-ui, sans-serif; }
.plx-marketplace .pm-stars { display: inline-flex; flex: none; align-items: center; gap: 3px; color: var(--pm-muted); font-size: 12px; }
.plx-marketplace .pm-stars svg { width: 14px; height: 14px; }
.plx-marketplace .pm-pagination { display: flex; justify-content: center; align-items: center; gap: 14px; padding-top: 6px; }
.plx-marketplace .pm-pagination .pm-button:enabled { color: var(--pm-accent); border-color: var(--pm-control); }
.plx-marketplace .pm-pagination .pm-button:disabled { background: transparent; border-color: transparent; }
.plx-marketplace .pm-error { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; padding: 16px; border: 1px solid var(--pm-error); border-radius: 10px; background: var(--pm-error-soft); color: var(--pm-error); }
.plx-marketplace .pm-error p { font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
.plx-marketplace .pm-empty { display: flex; flex-direction: column; align-items: center; padding: 48px 20px; gap: 10px; color: var(--pm-muted); text-align: center; border: 1px dashed var(--pm-border); border-radius: 12px; }
.plx-marketplace .pm-empty svg { width: 26px; height: 26px; }
.plx-marketplace .pm-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--pm-muted); }
.plx-marketplace .pm-loading > span { width: 12px; height: 12px; border: 2px solid var(--pm-border); border-top-color: var(--pm-accent); border-radius: 50%; animation: pm-spin .8s linear infinite; }
.plx-marketplace .pm-catalog, .plx-marketplace .pm-detail-anchor { scroll-margin-block-start: var(--pm-sticky-top, 0px); }
.plx-marketplace .pm-details { --pm-meta-top: calc(var(--pm-sticky-top, 0px) + var(--pm-header-height, 78px) + 10px); display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; max-width: 1120px; margin-inline: auto; padding-inline: clamp(0px, .6cqi, 8px); }
.plx-marketplace .pm-detail-header { position: sticky; top: var(--pm-sticky-top, 0px); z-index: 3; display: grid; gap: 4px; min-width: 0; padding-block-start: 8px; border-bottom: 1px solid var(--pm-border); background: var(--pm-canvas); }
.plx-marketplace .pm-detail-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; min-width: 0; }
.plx-marketplace .pm-detail-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 0 16px; min-width: 0; min-height: 34px; }
.plx-marketplace .pm-return { display: flex; align-items: center; gap: 4px; padding-inline-end: 15px; border-inline-end: 1px solid var(--pm-border); }
.plx-marketplace .pm-detail-navigation kbd { padding: 1px 5px; border: 1px solid var(--pm-border); border-radius: 4px; color: var(--pm-muted); font-size: 12px; }
.plx-marketplace .pm-button.pm-back { padding: 4px; min-height: 30px; }
.plx-marketplace .pm-detail-title, .plx-marketplace .pm-detail-actions { display: flex; align-items: center; flex-wrap: wrap; min-width: 0; max-width: 100%; gap: 4px 10px; }
.plx-marketplace .pm-detail-title h2 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: clamp(20px, 2.2cqi, 26px); font-weight: 680; }
.plx-marketplace .pm-detail-actions:empty { display: none; }
.plx-marketplace .pm-detail-actions .pm-no-release { color: var(--pm-muted); font-size: 13px; }
.plx-marketplace .pm-detail-actions .pm-package-status > :only-child:not(.pm-installed) { background: transparent; padding-inline: 0; font-weight: 400; }
.plx-marketplace .pm-detail-actions .pm-package-status + .pm-no-release { padding-inline-start: 10px; border-inline-start: 1px solid var(--pm-border); }
.plx-marketplace .pm-latest { display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; padding: 2px 7px; border-radius: 5px; background: var(--pm-surface); color: var(--pm-muted); font-size: 12px; }
.plx-marketplace .pm-latest code { color: var(--pm-ink); font-size: 12px; }
.plx-marketplace .pm-detail-description { color: var(--pm-ink); max-width: 84ch; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.plx-marketplace .pm-tabs { display: flex; align-items: center; gap: 16px; min-width: 0; max-width: 100%; border-bottom: 1px solid var(--pm-border); overflow-x: auto; }
.plx-marketplace .pm-detail-navigation .pm-tabs { align-self: stretch; border: 0; }
.plx-marketplace .pm-tabs button { align-self: stretch; padding: 6px 2px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--pm-muted); font-size: 13px; white-space: nowrap; }
.plx-marketplace .pm-tabs button:focus-visible { outline-offset: -2px; }
.plx-marketplace .pm-tabs button[aria-pressed="true"] { color: var(--pm-accent); border-bottom-color: var(--pm-accent); font-weight: 600; }
.plx-marketplace .pm-overview { display: grid; grid-template-areas: "content metadata"; grid-template-columns: minmax(0, 1fr) clamp(240px, 26%, 300px); align-items: start; gap: clamp(18px, 3cqi, 40px); min-width: 0; }
.plx-marketplace .pm-overview > :is(.pm-document, .pm-versions) { grid-area: content; }
.plx-marketplace .pm-package-meta { grid-area: metadata; position: sticky; top: var(--pm-meta-top); max-block-size: calc(min(100dvh, var(--pm-scrollport-height, 100dvh)) - var(--pm-meta-top) - 10px); overflow-y: auto; scrollbar-width: thin; min-width: 0; padding: 2px 4px 4px 16px; border-inline-start: 1px solid var(--pm-border); }
.plx-marketplace .pm-meta-toggle { display: none; }
.plx-marketplace .pm-meta-content, .plx-marketplace .pm-meta-content > section { display: grid; min-width: 0; gap: 6px; }
.plx-marketplace .pm-meta-content { gap: 12px; }
.plx-marketplace .pm-meta-content > * + * { padding-block-start: 10px; border-block-start: 1px solid var(--pm-border); }
.plx-marketplace .pm-meta-content h3 { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px; font-size: 14px; }
.plx-marketplace .pm-meta-content h3 code { color: var(--pm-muted); }
.plx-marketplace .pm-meta-content .pm-fact dd { min-width: 0; max-width: 100%; }
.plx-marketplace .pm-meta-content .pm-avatar { width: 16px; height: 16px; }
.plx-marketplace .pm-meta-content .pm-tags { gap: 4px; }
.plx-marketplace .pm-plugin-dependency { display: grid; gap: 2px; margin-block-start: 4px; }
.plx-marketplace .pm-plugin-dependency dd { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; color: var(--pm-muted); }
.plx-marketplace .pm-readme-outline { display: grid; min-width: 0; gap: 2px; }
.plx-marketplace .pm-readme-outline button { padding: 3px 1px; border: 0; background: transparent; color: var(--pm-accent); text-align: start; font-size: 13px; overflow-wrap: anywhere; }
.plx-marketplace .pm-readme-outline button:hover { text-decoration: underline; }
.plx-marketplace .pm-readme-outline button[data-depth="3"] { padding-inline-start: 12px; }
.plx-marketplace .pm-readme [id] { scroll-margin-block-start: var(--pm-meta-top); }
.plx-marketplace .pm-dist-tags summary { cursor: pointer; color: var(--pm-accent); font-size: 12px; }
.plx-marketplace .pm-dist-tags[open] summary { margin-block-end: 4px; }
.plx-marketplace .pm-document > h3, .plx-marketplace .pm-document-source { font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--pm-muted); }
.plx-marketplace .pm-facts { display: grid; width: 100%; gap: 3px; }
.plx-marketplace .pm-fact { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 2px 8px; font-size: 13px; overflow-wrap: anywhere; }
.plx-marketplace .pm-fact dt, .plx-marketplace .pm-coverage { color: var(--pm-muted); }
.plx-marketplace .pm-fact dd { font-variant-numeric: tabular-nums; }
.plx-marketplace .pm-coverage { font-size: 13px; line-height: 1.45; }
.plx-marketplace .pm-overview-facts, .plx-marketplace .pm-overview-facts .pm-facts { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; width: auto; }
.plx-marketplace .pm-external { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
.plx-marketplace .pm-note { background: var(--pm-surface); border-left: 2px solid var(--pm-border); color: var(--pm-muted); padding: 8px 10px; font-size: 13px; }
.plx-marketplace .pm-document { display: grid; gap: 8px; align-content: start; min-width: 0; }
.plx-marketplace .pm-readme { max-width: 94ch; min-width: 0; font-size: 15px; line-height: 1.6; overflow-wrap: anywhere; }
.plx-marketplace .pm-readme :is(h1, h2, h3, h4, h5, h6) { margin: 1.05em 0 .35em; font-weight: 650; line-height: 1.3; letter-spacing: -.02em; }
.plx-marketplace .pm-readme h1 { font-size: 22px; }
.plx-marketplace .pm-readme h2 { font-size: 19px; }
.plx-marketplace .pm-readme h3 { font-size: 16px; }
.plx-marketplace .pm-readme :is(h4, h5, h6) { font-size: 14px; }
.plx-marketplace .pm-readme :is(p, ul, ol, blockquote, figure, .pm-readme-table) { margin: 0 0 .7em; }
.plx-marketplace .pm-readme :is(p, ul, ol, blockquote) { max-width: 84ch; }
.plx-marketplace .pm-readme :is(ul, ol) { padding-inline-start: 1.6em; }
.plx-marketplace .pm-readme ul { list-style: disc; }
.plx-marketplace .pm-readme ol { list-style: decimal; }
.plx-marketplace .pm-readme li { margin-block: .18em; }
.plx-marketplace .pm-readme li > p { margin-bottom: .3em; }
.plx-marketplace .pm-readme a { text-decoration: underline; }
.plx-marketplace .pm-readme code { border-radius: 4px; padding: .12em .35em; background: var(--pm-surface); font-size: .88em; }
.plx-marketplace .pm-readme-code { min-width: 0; border: 1px solid var(--pm-border); border-radius: var(--pm-radius); background: var(--pm-surface); }
.plx-marketplace .pm-code-language { margin: 0; padding: 3px 11px; border-bottom: 1px solid var(--pm-border); color: var(--pm-muted); font: 12px/1.5 var(--pm-mono); overflow-wrap: anywhere; }
.plx-marketplace .pm-readme pre { margin: 0; padding: 8px 11px; max-width: 100%; overflow-x: auto; font: 13px/1.5 var(--pm-mono); white-space: pre; tab-size: 2; }
.plx-marketplace .pm-readme pre > code { padding: 0; border-radius: 0; background: transparent; color: var(--pm-ink); font: inherit; white-space: pre; overflow-wrap: normal; }
.plx-marketplace .pm-code-token { color: light-dark(var(--pm-code-light),var(--pm-code-dark)); }

.plx-marketplace .pm-readme blockquote { border-left: 3px solid var(--pm-border); padding-left: 16px; color: var(--pm-muted); }
.plx-marketplace .pm-readme blockquote > :last-child { margin-bottom: 0; }
.plx-marketplace .pm-readme hr { margin: 16px 0; border: 0; border-top: 1px solid var(--pm-border); }
.plx-marketplace .pm-readme-html { white-space: pre-wrap; }
.plx-marketplace .pm-readme-table { overflow-x: auto; border: 1px solid var(--pm-border); border-radius: 8px; }
.plx-marketplace .pm-readme table { border-collapse: collapse; min-width: 100%; width: max-content; font-size: 13px; }
.plx-marketplace .pm-readme :is(th, td) { padding: 5px 9px; border-bottom: 1px solid var(--pm-border); text-align: left; }
.plx-marketplace .pm-readme th { background: var(--pm-surface); font-weight: 600; }
.plx-marketplace .pm-readme tbody > tr:last-child > td { border-bottom: 0; }
.plx-marketplace .pm-readme input.pm-readme-check { display: inline-block; width: auto; min-height: 0; margin: 0 .5em 0 0; padding: 0; vertical-align: middle; }
.plx-marketplace .pm-readme > :first-child { margin-block-start: 0; }
.plx-marketplace .pm-readme > :last-child { margin-block-end: 0; }
.plx-marketplace .pm-version-picker { display: grid; gap: 8px; min-width: 0; }
.plx-marketplace .pm-release-list { margin: 0; padding: 0; list-style: none; border-block-start: 1px solid var(--pm-border); }
.plx-marketplace .pm-release-list > li { border-block-end: 1px solid var(--pm-border); }
.plx-marketplace .pm-release-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 6px 12px; width: 100%; padding: 10px 12px; border: 0; background: transparent; color: var(--pm-ink); text-align: start; }
.plx-marketplace .pm-release-row:hover { background: var(--pm-surface); }
.plx-marketplace .pm-release-row[aria-expanded="true"] { background: var(--pm-accent-soft); box-shadow: inset 3px 0 var(--pm-accent); }
.plx-marketplace .pm-release-row:focus-visible { outline-offset: -2px; }
.plx-marketplace .pm-release-row::after { content: ''; width: 8px; height: 8px; margin-inline: 3px; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(-45deg); }
.plx-marketplace .pm-release-row[aria-expanded="true"]::after { transform: rotate(45deg); }
.plx-marketplace .pm-release-identity { display: flex; align-items: baseline; flex-wrap: wrap; min-width: 0; gap: 4px 8px; }
.plx-marketplace .pm-release-identity code { font-size: 14px; font-weight: 650; }
.plx-marketplace .pm-release-row time, .plx-marketplace .pm-version-note { color: var(--pm-muted); font-size: 13px; }
.plx-marketplace .pm-release-list .pm-release { padding: 12px; }
.plx-marketplace .pm-version-field { max-width: 350px; }
.plx-marketplace .pm-versions, .plx-marketplace .pm-release { display: grid; align-content: start; gap: 10px; min-width: 0; }
.plx-marketplace .pm-release { padding-block-start: 10px; border-top: 1px solid var(--pm-border); }
.plx-marketplace .pm-provenance { display: flex; flex-direction: column; gap: 8px; }
.plx-marketplace .pm-dependencies > div { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--pm-border); }
.plx-marketplace .pm-dependencies dt { min-width: 0; overflow-wrap: anywhere; }
.plx-marketplace .pm-dependencies dd { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.plx-marketplace .pm-integrity { overflow-wrap: anywhere; }
.plx-marketplace .pm-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@container (max-width: 740px) {
  .plx-marketplace .pm-catalog { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "search" "filters" "status" "results"; }
  .plx-marketplace .pm-button.pm-compact-filters { display: inline-flex; }
  .plx-marketplace .pm-compact-filters[aria-expanded="true"] { color: var(--pm-accent); background: var(--pm-accent-soft); }
  .plx-marketplace .pm-filter-sidebar { display: none; position: static; margin-block: 6px; padding: 6px 12px; max-height: min(52dvh, 30rem); border: 1px solid var(--pm-border); border-radius: 8px; overscroll-behavior: contain; }
  .plx-marketplace .pm-filter-sidebar[data-open="true"] { display: block; }
  .plx-marketplace .pm-sidebar-title { display: none; }
  .plx-marketplace label.pm-filter-option { min-height: 34px; }
  .plx-marketplace .pm-overview { grid-template-areas: "metadata" "content"; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .plx-marketplace .pm-package-meta { position: static; max-block-size: none; overflow: visible; padding: 0; border: 0; border-block-end: 1px solid var(--pm-border); }
  .plx-marketplace .pm-meta-toggle { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 7px 3px; background: transparent; border: 0; color: var(--pm-ink); font-weight: 600; }
  .plx-marketplace .pm-meta-toggle::after { content: ''; width: 7px; height: 7px; border: solid var(--pm-muted); border-width: 0 1px 1px 0; transform: rotate(45deg); }
  .plx-marketplace .pm-meta-toggle[aria-expanded="true"]::after { transform: rotate(225deg); }
  .plx-marketplace .pm-package-meta[data-expanded="false"] .pm-meta-content { display: none; }
  .plx-marketplace .pm-meta-content { padding: 4px 3px 12px; }
  .plx-marketplace .pm-meta-content > section:first-child > h3 { display: none; }
}
@container (max-width: 480px) {
  .plx-marketplace .pm-release-row { grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; }
  .plx-marketplace .pm-release-row time { grid-column: 1; }
  .plx-marketplace .pm-release-row::after { grid-area: 1 / 2 / 3 / 3; }
  .plx-marketplace .pm-detail-navigation { column-gap: 8px; }
  .plx-marketplace .pm-return { padding-inline-end: 6px; }
  .plx-marketplace .pm-detail-navigation kbd { display: none; }
  .plx-marketplace .pm-tabs { gap: 8px; }
  .plx-marketplace .pm-button.pm-back { gap: 4px; padding-inline: 1px; }
  .plx-marketplace .pm-detail-header { padding-block-start: 4px; }
  .plx-marketplace .pm-details { padding: 0; gap: 8px; }
  .plx-marketplace .pm-readme pre { padding-inline: 8px; }
}
@keyframes pm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .plx-marketplace .pm-loading > span { animation: none; } .plx-marketplace .pm-button { transition: none; } }
`
