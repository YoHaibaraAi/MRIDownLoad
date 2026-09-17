(function initDownloader(root, factory) {
  const api = factory();
  root.RWJDownloader = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function makeDownloader() {
  "use strict";

  function sanitizePathSegment(value, fallback = "series") {
    const cleaned = String(value ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80);
    return cleaned || fallback;
  }

  function sortByImageNumber(images) {
    return [...images].sort((a, b) => {
      const left = Number(a?.imageNumber);
      const right = Number(b?.imageNumber);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
      return String(a?.instanceUid ?? "").localeCompare(String(b?.instanceUid ?? ""));
    });
  }

  function formatStudyDate(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (digits.length >= 8) return digits.slice(0, 8);
    return new Date().toISOString().slice(0, 10).replaceAll("-", "");
  }

  function makeZipName(study) {
    const description = sanitizePathSegment(study?.studyDesc, "STUDY").replace(/\s+/g, "_");
    return `${formatStudyDate(study?.studyDate)}_${description}_DICOM.zip`;
  }

  function hasDicmMarker(buffer) {
    if (buffer.byteLength < 132) return false;
    const bytes = new Uint8Array(buffer, 128, 4);
    return bytes[0] === 0x44 && bytes[1] === 0x49 && bytes[2] === 0x43 && bytes[3] === 0x4d;
  }

  function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("已取消", "AbortError"));
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("已取消", "AbortError"));
      }, { once: true });
    });
  }

  class DownloadManager {
    constructor({ client, onProgress, concurrency = 4, maxRetries = 3, zipFactory }) {
      this.client = client;
      this.onProgress = onProgress || (() => {});
      this.concurrency = concurrency;
      this.maxRetries = maxRetries;
      this.zipFactory = zipFactory || (() => new globalThis.JSZip());
      this.controller = null;
    }

    cancel() {
      this.controller?.abort();
    }

    async retryDownload(instance, signal) {
      let lastError;
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          const result = await this.client.downloadDicom(instance, signal);
          if (result.data.byteLength < 132) throw new Error(`DICOM 数据过短（${result.data.byteLength} bytes）`);
          return { ...result, part10: hasDicmMarker(result.data) };
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          lastError = error;
          if (attempt < this.maxRetries) await abortableDelay(500 * (2 ** attempt), signal);
        }
      }
      throw lastError;
    }

    async run(study, selectedSeries) {
      if (this.controller) throw new Error("已有下载任务正在运行");
      this.controller = new AbortController();
      const { signal } = this.controller;
      const state = { phase: "instances", completed: 0, total: 0, failed: 0, bytes: 0, currentSeries: "" };
      this.onProgress({ ...state });

      try {
        const groups = await this.client.getInstances(selectedSeries, signal);
        const seriesByUid = new Map(selectedSeries.map((item) => [item.seriesUid, item]));
        const folderByUid = new Map();
        const usedFolders = new Set();
        for (const series of selectedSeries) {
          const base = sanitizePathSegment(`${series.seriesNumber}_${series.seriesDes}`, `series_${series.seriesNumber}`);
          let folder = base;
          let suffix = 2;
          while (usedFolders.has(folder)) folder = `${base}_${suffix++}`;
          usedFolders.add(folder);
          folderByUid.set(series.seriesUid, folder);
        }

        const tasks = [];
        for (const group of groups) {
          const sorted = sortByImageNumber(group.imageBeans);
          sorted.forEach((instance, index) => tasks.push({
            instance,
            index,
            count: sorted.length,
            series: seriesByUid.get(group.seriesUid) || seriesByUid.get(instance.seriesUid),
            folder: folderByUid.get(group.seriesUid) || folderByUid.get(instance.seriesUid)
          }));
        }
        if (!tasks.length) throw new Error("服务器没有返回可下载的 DICOM Instance");
        state.total = tasks.length;
        state.phase = "download";
        this.onProgress({ ...state });

        const zip = this.zipFactory();
        const failures = [];
        let cursor = 0;
        const worker = async () => {
          while (!signal.aborted) {
            const taskIndex = cursor++;
            if (taskIndex >= tasks.length) return;
            const task = tasks[taskIndex];
            state.currentSeries = task.series?.seriesDes || task.folder || "Series";
            this.onProgress({ ...state });
            try {
              const result = await this.retryDownload(task.instance, signal);
              const width = Math.max(3, String(task.count).length);
              const filename = `${String(task.index + 1).padStart(width, "0")}.dcm`;
              zip.file(`${task.folder || "series"}/${filename}`, result.data);
              state.bytes += result.data.byteLength;
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              failures.push({
                seriesUid: task.instance.seriesUid,
                instanceUid: task.instance.instanceUid,
                imageNumber: task.instance.imageNumber,
                message: error?.message || String(error)
              });
              state.failed += 1;
            } finally {
              state.completed += 1;
              this.onProgress({ ...state });
            }
          }
        };

        await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, worker));
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        if (state.completed === state.failed) throw new Error("所有 DICOM 均下载失败，未生成 ZIP");

        state.phase = "zip";
        state.currentSeries = "正在生成 ZIP";
        this.onProgress({ ...state, zipPercent: 0 });
        const blob = await zip.generateAsync(
          { type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
          (metadata) => this.onProgress({ ...state, zipPercent: Math.round(metadata.percent) })
        );
        return { blob, filename: makeZipName(study), failures, bytes: state.bytes, total: state.total };
      } finally {
        this.controller = null;
      }
    }
  }

  return { DownloadManager, formatStudyDate, hasDicmMarker, makeZipName, sanitizePathSegment, sortByImageNumber };
});
