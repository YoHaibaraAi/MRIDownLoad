(function startContentScript() {
  "use strict";
  if (document.getElementById("rwj-dicom-downloader-root")) return;

  const SOURCE = "RWJ_DICOM_DOWNLOADER";
  let manager = null;
  let preparationController = null;

  function requestPageState(timeoutMs = 1500, signal) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      if (signal?.aborted) return reject(new DOMException("已取消", "AbortError"));
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("读取页面 Vue store 超时"));
      }, timeoutMs);
      function onAbort() {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        reject(new DOMException("已取消", "AbortError"));
      }
      function onMessage(event) {
        const data = event.data;
        if (event.source !== window || data?.source !== SOURCE || data?.type !== "STATE_RESPONSE" || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        resolve(data.payload || { found: false });
      }
      window.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      window.postMessage({ source: SOURCE, type: "STATE_REQUEST", requestId }, location.origin);
    });
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("已取消", "AbortError"));
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException("已取消", "AbortError"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function normalizeBridgeStudy(snapshot) {
    const study = snapshot?.study;
    if (!study?.series?.length) return null;
    return {
      studyDate: study.studyDate || "",
      studyDesc: study.studyDesc || "未命名检查",
      imageCount: Number(study.imageCount) || study.series.reduce((sum, item) => sum + Number(item.imageCount || 0), 0),
      domainId: snapshot.domainId || "",
      series: study.series.map(RWJApi.normalizeSeries).filter(Boolean)
    };
  }

  async function loadStudy() {
    let snapshot = { found: false };
    try { snapshot = await requestPageState(); } catch (_) { /* API fallback below */ }
    const fromStore = normalizeBridgeStudy(snapshot);
    if (fromStore?.series.length) return fromStore;
    return RWJApi.getStudyFromCurrentUrl(location.href);
  }

  async function waitForDownloadContext(study, signal) {
    const deadline = Date.now() + 10_000;
    let snapshot = { found: false };
    do {
      try { snapshot = await requestPageState(1500, signal); } catch (error) {
        if (error?.name === "AbortError") throw error;
        snapshot = { found: false };
      }
      if (snapshot.curSerieAe) break;
      await delay(500, signal);
    } while (Date.now() < deadline);

    if (!snapshot.curSerieAe) {
      throw new Error("请先打开一个影像序列，等待影像加载完成后重试。");
    }
    let staticKey = snapshot.staticKey;
    if (!/^[0-9a-f]{32}$/i.test(staticKey || "")) staticKey = await RWJApi.getStaticKey(signal);
    return {
      staticKey,
      curSerieAe: snapshot.curSerieAe,
      domainId: snapshot.domainId || study.domainId || ""
    };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const ui = new RWJUi.DownloaderUi({
    loadStudy,
    async download(study, selectedSeries, onProgress) {
      preparationController = new AbortController();
      try {
        const context = await waitForDownloadContext(study, preparationController.signal);
        const client = RWJApi.createClient(context);
        manager = new RWJDownloader.DownloadManager({ client, onProgress, concurrency: 4, maxRetries: 3 });
        const result = await manager.run(study, selectedSeries);
        saveBlob(result.blob, result.filename);
        return result;
      } finally {
        preparationController = null;
        manager = null;
      }
    },
    cancel() {
      preparationController?.abort();
      manager?.cancel();
    }
  });

  void ui;
})();
