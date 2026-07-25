// oxlint-disable-next-line typescript/triple-slash-reference -- source consumers need the adapter's ambient CSS module declaration.
/// <reference path="./types/worksplit-react.d.ts" />

/**
 * Host-integrated split panes for Workbench extension views.
 *
 * Layout values are percentages. Pair `WorkbenchSplitView.onLayoutCommit` with
 * `useStoredSplitLayout` so pointer movement does not write storage before resize commit. Callers
 * own a stable storage key and a sanitizer for their pane model.
 */
export {
	WorkbenchSplitView,
	type SplitViewHandle,
	type SplitViewLayout,
	type SplitViewPane,
	type WorkbenchSplitViewProps,
} from './app/workbench/split/view'
export { sanitizeTwoPanelLayout, useStoredSplitLayout } from './app/workbench/split/storage'
