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
.plx-marketplace .pm-search { display: flex; flex-direction: column; gap: 12px; }
.plx-marketplace .pm-search-row { display: flex; align-items: flex-end; gap: 10px; }
.plx-marketplace .pm-search-row > .pm-button { min-height: 44px; padding-inline: 22px; }
.plx-marketplace .pm-search-field { flex: 1; min-width: 0; }
.plx-marketplace label { display: block; margin-bottom: 7px; font-size: 12px; color: var(--pm-muted); font-weight: 550; }
.plx-marketplace input, .plx-marketplace select { display: block; width: 100%; min-width: 0; min-height: 40px; border: 1px solid var(--pm-border); border-radius: 8px; padding: 9px 11px; color: var(--pm-ink); background: var(--pm-canvas); outline-offset: 2px; font-size: 13px; }
.plx-marketplace input::placeholder { color: var(--pm-muted); opacity: .8; }
.plx-marketplace .pm-search-input { position: relative; }
.plx-marketplace .pm-search-input > svg { position: absolute; top: 13px; left: 14px; color: var(--pm-muted); pointer-events: none; }
.plx-marketplace .pm-search-input > input { padding-left: 42px; min-height: 44px; font-size: 14px; }
.plx-marketplace .pm-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
.plx-marketplace .pm-toolbar .pm-button { min-height: 32px; font-size: 12px; padding-block: 5px; }
.plx-marketplace .pm-filters { margin: 0; min-width: 0; padding: 16px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; border: 1px solid var(--pm-border); border-radius: 10px; background: var(--pm-surface); }
.plx-marketplace .pm-field { min-width: 0; }
.plx-marketplace .pm-applied { overflow-wrap: anywhere; padding: 0 10px; }
.plx-marketplace .pm-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
.plx-marketplace .pm-card { display: flex; flex-direction: column; min-width: 0; padding: 20px; gap: 12px; background: var(--pm-canvas); border: 1px solid var(--pm-border); border-radius: 12px; transition: border-color .15s; }
.plx-marketplace .pm-card:hover { border-color: var(--pm-muted); }
.plx-marketplace .pm-card-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.plx-marketplace .pm-package-icon { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid var(--pm-border); border-radius: 9px; background: var(--pm-surface); color: var(--pm-muted); }
.plx-marketplace .pm-badge { display: inline-flex; align-items: center; white-space: nowrap; border-radius: 5px; padding: 3px 7px; background: var(--pm-surface); color: var(--pm-muted); font-size: 11px; line-height: 1.4; font-weight: 550; }
.plx-marketplace .pm-official, .plx-marketplace .pm-verified { background: var(--pm-positive-soft); color: var(--pm-positive); }
.plx-marketplace .pm-description { font-size: 13px; color: var(--pm-muted); line-height: 1.65; min-height: 43px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.plx-marketplace .pm-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.plx-marketplace .pm-tags:empty { display: none; }
.plx-marketplace .pm-chip { display: inline-block; border: 1px solid transparent; padding: 3px 7px; border-radius: 5px; font: inherit; font-size: 11px; line-height: 1.4; background: var(--pm-surface); color: var(--pm-muted); }
.plx-marketplace button.pm-chip:hover { border-color: var(--pm-border); color: var(--pm-ink); }
.plx-marketplace .pm-category { background: var(--pm-accent-soft); color: var(--pm-accent); }
.plx-marketplace .pm-source { display: flex; flex-direction: column; gap: 2px; color: var(--pm-muted); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.plx-marketplace .pm-source > span:last-child { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.plx-marketplace .pm-card-facts { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding-top: 3px; margin-top: auto; font-size: 11px; color: var(--pm-muted); }
.plx-marketplace .pm-card-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 10px; border-top: 1px solid var(--pm-border); }
.plx-marketplace .pm-card-footer > .pm-link { margin-left: auto; }
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
@container (max-width: 900px) { .plx-marketplace .pm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .plx-marketplace .pm-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 560px) { .plx-marketplace .pm-grid { grid-template-columns: minmax(0, 1fr); } .plx-marketplace .pm-card { padding: 17px; } .plx-marketplace .pm-release, .plx-marketplace .pm-document { padding: 16px; } .plx-marketplace .pm-search-row > .pm-button { padding-inline: 15px; } }
@container (max-width: 360px) { .plx-marketplace .pm-filters { grid-template-columns: minmax(0, 1fr); } .plx-marketplace h2 { font-size: 23px; } }
@keyframes pm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .plx-marketplace .pm-loading > span { animation: none; } .plx-marketplace .pm-card, .plx-marketplace .pm-button { transition: none; } }
`
