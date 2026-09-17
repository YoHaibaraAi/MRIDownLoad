(function startPageBridge() {
  "use strict";
  const SOURCE = "RWJ_DICOM_DOWNLOADER";
  const MAX_DOM_NODES = 500;
  const MAX_DOCUMENTS = 10;
  const cachedContext = { staticKey: "", domainId: "", curSerieAe: "" };
  let observedStore = null;
  let publishedContextSignature = "";

  function getSameOriginDocuments() {
    const documents = [document];
    for (let cursor = 0; cursor < documents.length && documents.length < MAX_DOCUMENTS; cursor += 1) {
      let frames;
      try { frames = documents[cursor].querySelectorAll("iframe"); } catch (_) { continue; }
      for (const frame of frames) {
        if (documents.length >= MAX_DOCUMENTS) break;
        try {
          const childDocument = frame.contentDocument;
          if (childDocument && !documents.includes(childDocument)) documents.push(childDocument);
        } catch (_) {
          // Cross-origin frames are intentionally ignored.
        }
      }
    }
    return documents;
  }

  function findVueStore() {
    let scanned = 0;
    for (const candidateDocument of getSameOriginDocuments()) {
      const appStore = candidateDocument.querySelector("#app")?.__vue__?.$store;
      if (appStore?.state?.phone) return appStore;
      const nodes = candidateDocument.querySelectorAll("*");
      const limit = Math.min(nodes.length, MAX_DOM_NODES - scanned);
      for (let index = 0; index < limit; index += 1) {
        const store = nodes[index].__vue__?.$store;
        if (store?.state?.phone) return store;
      }
      scanned += limit;
      if (scanned >= MAX_DOM_NODES) break;
    }
    return null;
  }

  function normalizeSeries(item, index) {
    if (!item || typeof item !== "object") return null;
    const seriesUid = item.seriesUid ?? item.seriesUID ?? item.SeriesInstanceUID;
    if (!seriesUid) return null;
    const number = item.seriesNumber ?? item.seriesNo ?? item.SeriesNumber ?? index + 1;
    return {
      seriesUid: String(seriesUid),
      seriesUidId: item.seriesUidId ?? item.seriesID ?? item.id ?? "",
      seriesNumber: Number(number) || index + 1,
      seriesDes: String(item.seriesDes ?? item.seriesDesc ?? item.description ?? `Series ${number}`),
      imageCount: Number(item.imageCount ?? item.imagesCount ?? item.count ?? 0) || 0,
      fileSize: Number(item.fileSize ?? 0) || 0
    };
  }

  function collectSeries(value, output = [], seen = new WeakSet(), depth = 0) {
    if (!value || typeof value !== "object" || depth > 4 || output.length >= 500 || seen.has(value)) return output;
    seen.add(value);
    const normalized = normalizeSeries(value, output.length);
    if (normalized) {
      if (!output.some((item) => item.seriesUid === normalized.seriesUid)) output.push(normalized);
      return output;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectSeries(item, output, seen, depth + 1);
      return output;
    }
    const preferredKeys = ["selectedImageList", "seriesList", "series", "children", "list", "data"];
    for (const key of preferredKeys) {
      try { collectSeries(value[key], output, seen, depth + 1); } catch (_) { /* Vue getter unavailable */ }
    }
    if (!Array.isArray(value)) {
      let inspected = 0;
      for (const key of Object.keys(value)) {
        if (preferredKeys.includes(key) || inspected++ >= 50) continue;
        try { collectSeries(value[key], output, seen, depth + 1); } catch (_) { /* Vue getter unavailable */ }
      }
    }
    return output;
  }

  function findStudy(value, seen = new WeakSet(), depth = 0) {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    if (value.studyDate != null || value.studyDesc != null || value.checkPart != null) return value;
    let values;
    if (Array.isArray(value)) {
      values = value;
    } else {
      values = [value.current, value.selected, value.patient, value.data, value.list];
      try { values.push(...Object.values(value).slice(0, 50)); } catch (_) { /* Vue getter unavailable */ }
    }
    for (const child of values) {
      const found = findStudy(child, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function getCurrentAe(phone, studySource = {}) {
    const activeIndex = Number.isInteger(Number(phone.activeName)) ? Number(phone.activeName) : 0;
    const candidates = [
      phone.curSerieAe,
      phone.requestConfig?.[activeIndex]?.fromAe,
      phone.requestConfig?.[0]?.fromAe,
      studySource.fromAe
    ];
    for (const value of candidates) {
      if (value !== null && value !== undefined && value !== "") return value;
    }
    // The captured frontend calls String(value) before its truthy check. Once the
    // current Series is loaded, an explicitly undefined curSerieAe is therefore
    // sent as the literal plaintext "undefined" (confirmed against the HAR).
    if (phone.seriesList?.length && Object.prototype.hasOwnProperty.call(phone, "curSerieAe") && phone.curSerieAe === undefined) {
      return "undefined";
    }
    return "";
  }

  function captureContext(state) {
    if (!state || typeof state !== "object") return;
    const phone = state.phone || {};
    const staticKey = typeof state.staticKey === "string" ? state.staticKey : "";
    const domainId = state.prop?.domainId ?? phone.domainId ?? "";
    const curSerieAe = getCurrentAe(phone);
    if (staticKey) cachedContext.staticKey = String(staticKey);
    if (domainId) cachedContext.domainId = String(domainId);
    if (curSerieAe) cachedContext.curSerieAe = String(curSerieAe);
    if (window !== window.top) {
      const signature = `${cachedContext.staticKey}|${cachedContext.domainId}|${cachedContext.curSerieAe}`;
      if (signature !== publishedContextSignature) {
        publishedContextSignature = signature;
        window.top.postMessage({ source: SOURCE, type: "CONTEXT_CACHE", payload: { ...cachedContext } }, location.origin);
      }
    }
  }

  function observeStore(store) {
    if (!store?.state?.phone) return;
    captureContext(store.state);
    if (store === observedStore) return;
    observedStore = store;
    if (typeof store.subscribe === "function") {
      store.subscribe((_mutation, state) => captureContext(state));
    }
  }

  function snapshotStore() {
    const store = findVueStore();
    if (!store) return { found: false };
    const state = store.state;
    observeStore(store);
    const phone = state.phone || {};
    const studySource = findStudy(phone.patientList) || findStudy(phone.requestConfig) || {};
    const currentAe = getCurrentAe(phone, studySource) || cachedContext.curSerieAe;
    const preferredSeries = collectSeries(phone.seriesList);
    const series = preferredSeries.length ? preferredSeries : collectSeries(studySource.selectedImageList || phone.patientList);
    return {
      found: true,
      staticKey: (typeof state.staticKey === "string" && state.staticKey) || cachedContext.staticKey,
      domainId: String(state.prop?.domainId ?? studySource.domainId ?? cachedContext.domainId ?? ""),
      curSerieAe: String(currentAe),
      study: {
        studyDate: String(studySource.studyDate ?? studySource.checkDate ?? ""),
        studyDesc: String(studySource.studyDesc ?? studySource.checkPart ?? ""),
        imageCount: Number(studySource.imageCount ?? series.reduce((sum, item) => sum + item.imageCount, 0)) || 0,
        series
      }
    };
  }

  const discoveryTimer = setInterval(() => observeStore(findVueStore()), 50);
  setTimeout(() => clearInterval(discoveryTimer), 30_000);

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.source === SOURCE && data?.type === "CONTEXT_CACHE" && event.origin === location.origin && event.source !== window) {
      const payload = data.payload || {};
      if (typeof payload.staticKey === "string" && payload.staticKey) cachedContext.staticKey = payload.staticKey;
      if (typeof payload.domainId === "string" && payload.domainId) cachedContext.domainId = payload.domainId;
      if (typeof payload.curSerieAe === "string" && payload.curSerieAe) cachedContext.curSerieAe = payload.curSerieAe;
      return;
    }
    if (event.source !== window || data?.source !== SOURCE || data?.type !== "STATE_REQUEST" || typeof data.requestId !== "string") return;
    let payload;
    try {
      payload = snapshotStore();
    } catch (error) {
      payload = { found: false, error: error?.message || String(error) };
    }
    window.postMessage({ source: SOURCE, type: "STATE_RESPONSE", requestId: data.requestId, payload }, location.origin);
  });
})();
