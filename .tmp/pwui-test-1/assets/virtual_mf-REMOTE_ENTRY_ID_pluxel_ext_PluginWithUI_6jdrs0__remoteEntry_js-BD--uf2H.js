const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/localSharedImportMap-YJZkTlZN.js","assets/dist-Bkn8ZjXc.js","assets/preload-helper-CKGNGTs9.js","assets/virtualExposes-CnAaxa8U.js","assets/virtual_mf-exposes_pluxel_ext_PluginWithUI_6jdrs0__remoteEntry_js-CVIpotUG.js"])))=>i.map(i=>d[i]);
import { t as __vitePreload } from "./preload-helper-CKGNGTs9.js";
import { t as init$1 } from "./dist-Bkn8ZjXc.js";
var __mfResolveGlobalKey = "__mf_init____mf__virtual/pluxel_ext_PluginWithUI_6jdrs0__mf_v__runtimeInit__mf_v__.js__";
var __mfResolveState = globalThis[__mfResolveGlobalKey];
if (!__mfResolveState) {
	let initResolve, initReject;
	const initPromise = new Promise((re, rj) => {
		initResolve = re;
		initReject = rj;
	});
	__mfResolveState = globalThis[__mfResolveGlobalKey] = {
		initPromise,
		initResolve,
		initReject
	};
	if (typeof window === "undefined") initResolve({
		loadRemote: function() {
			return Promise.resolve(void 0);
		},
		loadShare: function() {
			return Promise.resolve(void 0);
		}
	});
}
var initResolve = __mfResolveState.initResolve;
var initTokens = {};
var shareScopeName = "default";
var mfName = "pluxel_ext_PluginWithUI_6jdrs0";
var localSharedImportMapPromise;
var exposesMapPromise;
async function getLocalSharedImportMap() {
	localSharedImportMapPromise ??= __vitePreload(() => import("./localSharedImportMap-YJZkTlZN.js"), __vite__mapDeps([0,1,2]));
	return localSharedImportMapPromise;
}
async function getExposesMap() {
	exposesMapPromise ??= __vitePreload(() => import("./virtualExposes-CnAaxa8U.js").then((mod) => mod.default ?? mod), __vite__mapDeps([3,4,2]));
	return exposesMapPromise;
}
async function init(shared = {}, initScope = []) {
	const { usedShared, usedRemotes } = await getLocalSharedImportMap();
	const initRes = init$1({
		name: mfName,
		remotes: usedRemotes,
		shared: usedShared,
		plugins: [],
		shareStrategy: "loaded-first"
	});
	var initToken = initTokens[shareScopeName];
	if (!initToken) initToken = initTokens[shareScopeName] = { from: mfName };
	if (initScope.indexOf(initToken) >= 0) return;
	initScope.push(initToken);
	initRes.initShareScopeMap("default", shared);
	initResolve(initRes);
	try {
		await Promise.all(await initRes.initializeSharing("default", {
			strategy: "loaded-first",
			from: "build",
			initScope
		}));
	} catch (e) {
		console.error(e);
	}
	return initRes;
}
async function getExposes(moduleName) {
	const exposesMap = await getExposesMap();
	if (!(moduleName in exposesMap)) throw new Error(`Module ${moduleName} does not exist in container.`);
	return exposesMap[moduleName]().then((res) => () => res);
}
export { init as n, getExposes as t };

//# sourceMappingURL=virtual_mf-REMOTE_ENTRY_ID_pluxel_ext_PluginWithUI_6jdrs0__remoteEntry_js-BD--uf2H.js.map