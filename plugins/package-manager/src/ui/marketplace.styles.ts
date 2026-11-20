export const marketplaceStyles = `
.plx-marketplace {
  --pm-canvas: #ffffff; --pm-surface: #f6f8fb; --pm-border: #dfe5ee;
  --pm-ink: #192538; --pm-muted: #637185; --pm-accent: #315ccf;
  --pm-accent-soft: #edf2ff; --pm-positive: #24755c; --pm-positive-soft: #edf8f3;
  --pm-error: #b33341; --pm-error-soft: #fff3f4;
  container-type: inline-size; color-scheme: light; color: var(--pm-ink);
  font: 400 14px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  min-width: 0; text-align: left;
}
.plx-marketplace[data-color-scheme="dark"] {
  --pm-canvas: #191d25; --pm-surface: #202630; --pm-border: #343d4b;
  --pm-ink: #e8edf5; --pm-muted: #a3afc1; --pm-accent: #a3bcff;
  --pm-accent-soft: #293754; --pm-positive: #91d8b6; --pm-positive-soft: #233b32;
  --pm-error: #ffb1ba; --pm-error-soft: #442a32; color-scheme: dark;
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
.plx-marketplace button:disabled { cursor: default; opacity: .45; }
.plx-marketplace :is(button, a, input, select):focus-visible { outline: 2px solid var(--pm-accent); outline-offset: 3px; }
.plx-marketplace svg { flex-shrink: 0; vertical-align: middle; }
.plx-marketplace code { font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.plx-marketplace .pm-stack { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.plx-marketplace .pm-inline, .plx-marketplace .pm-between { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; }
.plx-marketplace .pm-between { justify-content: space-between; }
.plx-marketplace .pm-muted { color: var(--pm-muted); }
.plx-marketplace .pm-small { font-size: 12px; }
.plx-marketplace .pm-button { display: inline-flex; justify-content: center; align-items: center; gap: 7px; min-height: 36px; padding: 7px 12px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-canvas); color: var(--pm-ink); font-size: 13px; line-height: 1.3; font-weight: 550; text-decoration: none; transition: background .15s, border-color .15s; }
.plx-marketplace .pm-button:hover:not(:disabled) { background: var(--pm-surface); border-color: var(--pm-muted); }
.plx-marketplace .pm-primary { background: var(--pm-accent); border-color: var(--pm-accent); color: var(--pm-canvas); }
.plx-marketplace .pm-primary:hover:not(:disabled) { background: var(--pm-accent); border-color: var(--pm-accent); filter: brightness(.93); }
.plx-marketplace .pm-quiet { background: transparent; border-color: transparent; color: var(--pm-muted); }
.plx-marketplace .pm-link { background: transparent; border-color: transparent; color: var(--pm-accent); padding-inline: 0; }
.plx-marketplace .pm-link:hover:not(:disabled) { background: transparent; border-color: transparent; text-decoration: underline; text-underline-offset: 3px; }
.plx-marketplace .pm-catalog { min-width: 0; background: var(--pm-canvas); }
.plx-marketplace .pm-controls { position: sticky; top: 0; z-index: 2; background: var(--pm-canvas); padding: 6px 0 2px; }
.plx-marketplace .pm-controls-inner { position: relative; }
.plx-marketplace .pm-toolbar { display: flex; align-items: center; gap: 8px; }
.plx-marketplace .pm-search { position: relative; flex: 1; min-width: 0; }
.plx-marketplace label { display: block; margin-bottom: 7px; font-size: 12px; color: var(--pm-muted); font-weight: 550; }
.plx-marketplace input, .plx-marketplace select { display: block; width: 100%; min-width: 0; min-height: 36px; border: 1px solid var(--pm-border); border-radius: 7px; padding: 6px 9px; color: var(--pm-ink); background: var(--pm-canvas); font-size: 13px; }
.plx-marketplace input::placeholder { color: var(--pm-muted); }
.plx-marketplace .pm-search input { padding-inline-end: 36px; }
.plx-marketplace .pm-search input::-webkit-search-cancel-button { display: none; }
.plx-marketplace .pm-clear-search { position: absolute; inset-block: 4px; inset-inline-end: 4px; width: 28px; padding: 0; color: var(--pm-muted); border: 0; border-radius: 5px; background: transparent; }
.plx-marketplace .pm-clear-search:hover { background: var(--pm-surface); color: var(--pm-ink); }
.plx-marketplace .pm-wide-filters { display: flex; gap: 5px; }
.plx-marketplace .pm-button.pm-facet-trigger { min-height: 36px; gap: 6px; padding: 5px 8px; white-space: nowrap; }
.plx-marketplace .pm-facet-trigger::after { content: ''; width: 6px; height: 6px; border: solid currentColor; border-width: 0 1px 1px 0; transform: translateY(-2px) rotate(45deg); opacity: .7; }
.plx-marketplace .pm-facet-trigger[aria-expanded="true"] { border-color: var(--pm-accent); background: var(--pm-accent-soft); }
.plx-marketplace .pm-facet-trigger > span { padding-inline: 4px; color: var(--pm-accent); background: var(--pm-accent-soft); border-radius: 4px; font-variant-numeric: tabular-nums; }
.plx-marketplace .pm-button.pm-compact-filters, .plx-marketplace .pm-filter-switcher { display: none; }
.plx-marketplace .pm-filter-panel { position: absolute; z-index: 1; inset-block-start: calc(100% + 5px); inset-inline-end: 0; width: min(330px, 100%); display: grid; gap: 6px; padding: 8px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-canvas); box-shadow: 0 8px 24px rgba(0, 0, 0, .14); }
.plx-marketplace .pm-filter-options { max-height: min(320px, 52vh); overflow-y: auto; overscroll-behavior: contain; }
.plx-marketplace label.pm-filter-option { display: flex; align-items: center; gap: 8px; min-height: 33px; margin: 0; padding: 3px 6px; border-radius: 5px; color: var(--pm-ink); cursor: pointer; }
.plx-marketplace .pm-filter-option:hover, .plx-marketplace .pm-filter-option:focus-within { background: var(--pm-surface); }
.plx-marketplace .pm-filter-option input { flex: none; width: 15px; height: 15px; min-height: 0; margin: 0; padding: 0; accent-color: var(--pm-accent); }
.plx-marketplace .pm-option-count { margin-inline-start: auto; color: var(--pm-muted); font-variant-numeric: tabular-nums; }
.plx-marketplace .pm-catalog-status { min-height: 29px; padding: 3px 1px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.plx-marketplace .pm-catalog-count { margin-inline-start: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
.plx-marketplace .pm-selected-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; }
.plx-marketplace .pm-selected-filters .pm-button { min-height: 24px; padding: 2px 5px; font-size: 12px; }
.plx-marketplace .pm-badge { display: inline-flex; flex: none; align-items: center; white-space: nowrap; border-radius: 5px; padding: 2px 5px; background: var(--pm-surface); color: var(--pm-muted); font-size: 11px; line-height: 1.4; font-weight: 550; }
.plx-marketplace .pm-official, .plx-marketplace .pm-verified { background: var(--pm-positive-soft); color: var(--pm-positive); }
.plx-marketplace .pm-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.plx-marketplace .pm-tags:empty { display: none; }
.plx-marketplace .pm-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid transparent; padding: 3px 7px; border-radius: 5px; font: inherit; font-size: 11px; line-height: 1.4; background: var(--pm-surface); color: var(--pm-muted); }
.plx-marketplace button.pm-chip:hover { border-color: var(--pm-border); color: var(--pm-ink); }
.plx-marketplace .pm-chip.pm-applied-filter { max-width: min(165px, 100%); color: var(--pm-accent); background: var(--pm-accent-soft); }
.plx-marketplace .pm-category { background: var(--pm-accent-soft); color: var(--pm-accent); }
.plx-marketplace .pm-source { display: flex; flex-direction: column; gap: 2px; color: var(--pm-muted); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.plx-marketplace .pm-source > span:last-child { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.plx-marketplace .pm-results { border-top: 1px solid var(--pm-border); margin-top: 2px; }
.plx-marketplace .pm-results > ul { list-style: none; padding: 0; margin: 0; }
.plx-marketplace :is(.pm-result-header, .pm-result-row) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 20%) minmax(0, 15%) minmax(0, 12%) minmax(90px, 12%); gap: 10px; align-items: center; padding-inline: 8px; border-bottom: 1px solid var(--pm-border); }
.plx-marketplace .pm-result-header { min-height: 27px; font-size: 12px; color: var(--pm-muted); background: var(--pm-surface); }
.plx-marketplace .pm-result-row { min-height: 48px; padding-block: 4px; font-size: 12px; }
.plx-marketplace .pm-result-row:hover, .plx-marketplace .pm-result-row:focus-within { background: var(--pm-surface); }
.plx-marketplace .pm-truncate { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plx-marketplace .pm-package-heading { display: flex; align-items: center; gap: 6px; min-width: 0; }
.plx-marketplace .pm-text-action { min-width: 0; border: 0; border-radius: 3px; padding: 0; text-align: start; background: transparent; color: var(--pm-ink); }
.plx-marketplace .pm-text-action:hover { color: var(--pm-accent); text-decoration: underline; text-underline-offset: 2px; }
.plx-marketplace .pm-text-action[aria-pressed="true"] { color: var(--pm-accent); }
.plx-marketplace .pm-package-name { font-size: 14px; font-weight: 650; line-height: 1.45; }
.plx-marketplace .pm-summary { color: var(--pm-muted); line-height: 1.4; }
.plx-marketplace .pm-package-author, .plx-marketplace .pm-row-version { min-width: 0; }
.plx-marketplace .pm-author { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; vertical-align: middle; }
.plx-marketplace .pm-avatar { flex: none; border-radius: 50%; object-fit: cover; }
.plx-marketplace .pm-row-source, .plx-marketplace .pm-unset { color: var(--pm-muted); }
.plx-marketplace .pm-no-release { display: block; color: var(--pm-muted); font-size: 11px; line-height: 1.3; }
.plx-marketplace .pm-repository { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; }
.plx-marketplace .pm-stars { display: inline-flex; align-items: center; gap: 4px; color: var(--pm-muted); font-size: 12px; }
.plx-marketplace .pm-stars svg { width: 14px; height: 14px; }
.plx-marketplace .pm-pagination { display: flex; justify-content: center; align-items: center; gap: 14px; padding-top: 6px; }
.plx-marketplace .pm-error { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; padding: 16px; border: 1px solid var(--pm-error); border-radius: 10px; background: var(--pm-error-soft); color: var(--pm-error); }
.plx-marketplace .pm-error p { font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
.plx-marketplace .pm-empty { display: flex; flex-direction: column; align-items: center; padding: 48px 20px; gap: 10px; color: var(--pm-muted); text-align: center; border: 1px dashed var(--pm-border); border-radius: 12px; }
.plx-marketplace .pm-empty svg { width: 26px; height: 26px; }
.plx-marketplace .pm-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--pm-muted); }
.plx-marketplace .pm-loading > span { width: 12px; height: 12px; border: 2px solid var(--pm-border); border-top-color: var(--pm-accent); border-radius: 50%; animation: pm-spin .8s linear infinite; }
.plx-marketplace .pm-back { padding-left: 0; }
.plx-marketplace .pm-detail-header { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
.plx-marketplace .pm-detail-description { color: var(--pm-muted); max-width: 76ch; }
.plx-marketplace .pm-detail-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; }
.plx-marketplace .pm-tabs { display: flex; align-items: center; gap: 22px; border-bottom: 1px solid var(--pm-border); overflow-x: auto; }
.plx-marketplace .pm-tabs button { padding: 12px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--pm-muted); font-size: 13px; white-space: nowrap; }
.plx-marketplace .pm-tabs button[aria-pressed="true"] { color: var(--pm-accent); border-bottom-color: var(--pm-accent); font-weight: 600; }
.plx-marketplace .pm-overview-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 24px; }
.plx-marketplace .pm-fact { display: flex; flex-direction: column; gap: 3px; overflow-wrap: anywhere; min-width: 0; }
.plx-marketplace .pm-fact > span:last-child { font-size: 13px; }
.plx-marketplace .pm-external { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
.plx-marketplace .pm-note { background: var(--pm-surface); border-left: 2px solid var(--pm-border); color: var(--pm-muted); padding: 12px 14px; font-size: 13px; }
.plx-marketplace .pm-document { display: flex; flex-direction: column; gap: 16px; padding: 20px; border: 1px solid var(--pm-border); border-radius: 10px; min-width: 0; background: var(--pm-canvas); }
.plx-marketplace .pm-readme { font-size: 14px; line-height: 1.8; min-width: 0; overflow-wrap: anywhere; }
.plx-marketplace .pm-readme > :first-child { margin-top: 0; }
.plx-marketplace .pm-readme > :last-child { margin-bottom: 0; }
.plx-marketplace .pm-readme :is(h1, h2, h3, h4, h5, h6) { margin: 1.5em 0 .6em; font-weight: 650; line-height: 1.35; letter-spacing: -.02em; }
.plx-marketplace .pm-readme h1 { font-size: 26px; }
.plx-marketplace .pm-readme h2 { font-size: 21px; }
.plx-marketplace .pm-readme h3 { font-size: 17px; }
.plx-marketplace .pm-readme :is(h4, h5, h6) { font-size: 14px; }
.plx-marketplace .pm-readme :is(p, ul, ol, blockquote, pre, .pm-readme-table) { margin: 0 0 1em; }
.plx-marketplace .pm-readme :is(ul, ol) { padding-left: 1.7em; }
.plx-marketplace .pm-readme li { margin-block: .3em; }
.plx-marketplace .pm-readme li > p { margin-bottom: .3em; }
.plx-marketplace .pm-readme a { text-decoration: underline; }
.plx-marketplace .pm-readme code { border-radius: 4px; padding: .12em .35em; background: var(--pm-surface); font-size: .88em; }
.plx-marketplace .pm-readme pre { padding: 14px 16px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-surface); overflow-x: auto; white-space: pre; }
.plx-marketplace .pm-readme pre > code { padding: 0; border-radius: 0; background: transparent; overflow-wrap: normal; }
.plx-marketplace .pm-readme blockquote { border-left: 3px solid var(--pm-border); padding-left: 16px; color: var(--pm-muted); }
.plx-marketplace .pm-readme blockquote > :last-child { margin-bottom: 0; }
.plx-marketplace .pm-readme hr { margin: 24px 0; border: 0; border-top: 1px solid var(--pm-border); }
.plx-marketplace .pm-readme-html { white-space: pre-wrap; }
.plx-marketplace .pm-readme-table { overflow-x: auto; border: 1px solid var(--pm-border); border-radius: 8px; }
.plx-marketplace .pm-readme table { border-collapse: collapse; min-width: 100%; width: max-content; font-size: 13px; }
.plx-marketplace .pm-readme :is(th, td) { padding: 9px 13px; border-bottom: 1px solid var(--pm-border); text-align: left; }
.plx-marketplace .pm-readme th { background: var(--pm-surface); font-weight: 600; }
.plx-marketplace .pm-readme tbody > tr:last-child > td { border-bottom: 0; }
.plx-marketplace .pm-readme input.pm-readme-check { display: inline-block; width: auto; min-height: 0; margin: 0 .5em 0 0; padding: 0; vertical-align: middle; }
.plx-marketplace .pm-version-field { max-width: 350px; }
.plx-marketplace .pm-release { padding: 20px; border: 1px solid var(--pm-border); border-radius: 12px; background: var(--pm-canvas); min-width: 0; }
.plx-marketplace .pm-provenance { display: flex; flex-direction: column; gap: 8px; }
.plx-marketplace .pm-dependencies > div { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--pm-border); }
.plx-marketplace .pm-dependencies dt { min-width: 0; overflow-wrap: anywhere; }
.plx-marketplace .pm-dependencies dd { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.plx-marketplace .pm-integrity { overflow-wrap: anywhere; }
.plx-marketplace .pm-install { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 16px; border-top: 1px solid var(--pm-border); }
.plx-marketplace .pm-review { padding: 20px; background: var(--pm-canvas); border: 1px solid var(--pm-accent); border-radius: 12px; display: flex; flex-direction: column; gap: 14px; }
.plx-marketplace .pm-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@container (max-width: 680px) {
  .plx-marketplace .pm-wide-filters, .plx-marketplace .pm-result-header, .plx-marketplace .pm-summary { display: none; }
  .plx-marketplace .pm-button.pm-compact-filters { display: inline-flex; }
  .plx-marketplace .pm-filter-switcher { display: block; }
  .plx-marketplace .pm-result-row { grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, .9fr) minmax(70px, 22%); column-gap: 8px; row-gap: 3px; padding: 5px 6px; }
  .plx-marketplace .pm-package { grid-area: 1 / 1 / 2 / 4; }
  .plx-marketplace .pm-package-author { grid-area: 2 / 1; }
  .plx-marketplace .pm-row-category { grid-area: 2 / 2; }
  .plx-marketplace .pm-row-source { grid-area: 2 / 3 / 3 / 5; text-align: end; }
  .plx-marketplace .pm-row-version { grid-area: 1 / 4; text-align: end; }
  .plx-marketplace .pm-catalog-status { align-items: start; }
  .plx-marketplace .pm-catalog-count { padding-block-start: 3px; }
}
@container (max-width: 560px) { .plx-marketplace .pm-release, .plx-marketplace .pm-document { padding: 16px; } }
@container (max-width: 360px) { .plx-marketplace h2 { font-size: 23px; } }
@keyframes pm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .plx-marketplace .pm-loading > span { animation: none; } .plx-marketplace .pm-button { transition: none; } }
`
