(function initUi(root, factory) {
  const api = factory();
  root.RWJUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function makeUi() {
  "use strict";

  function escapeText(value) {
    return String(value ?? "");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  class DownloaderUi {
    constructor(handlers) {
      this.handlers = handlers;
      this.study = null;
      this.studyHref = "";
      this.busy = false;
      this.root = document.createElement("div");
      this.root.id = "rwj-dicom-downloader-root";
      this.root.innerHTML = `
        <button class="rwj-dd-launch" type="button">DICOM 下载</button>
        <section class="rwj-dd-panel" hidden aria-label="DICOM 下载器">
          <header><strong>DICOM 下载</strong><button class="rwj-dd-close" type="button" aria-label="关闭">×</button></header>
          <div class="rwj-dd-body"><div class="rwj-dd-status">正在读取当前检查…</div></div>
        </section>`;
      document.documentElement.appendChild(this.root);
      this.launch = this.root.querySelector(".rwj-dd-launch");
      this.panel = this.root.querySelector(".rwj-dd-panel");
      this.body = this.root.querySelector(".rwj-dd-body");
      this.launch.addEventListener("click", () => this.open());
      this.root.querySelector(".rwj-dd-close").addEventListener("click", () => {
        if (!this.busy) this.panel.hidden = true;
      });
    }

    async open() {
      this.panel.hidden = false;
      if (this.busy) return;
      if (this.study && this.studyHref === location.href) return;
      this.study = null;
      this.showStatus("正在读取当前检查…");
      try {
        this.setStudy(await this.handlers.loadStudy());
      } catch (error) {
        this.showError(error?.message || String(error));
      }
    }

    showStatus(message) {
      this.body.replaceChildren();
      const node = document.createElement("div");
      node.className = "rwj-dd-status";
      node.textContent = message;
      this.body.appendChild(node);
    }

    showError(message) {
      this.busy = false;
      this.body.replaceChildren();
      const error = document.createElement("div");
      error.className = "rwj-dd-error";
      error.textContent = message;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试";
      retry.addEventListener("click", () => { this.study = null; this.open(); });
      this.body.append(error, retry);
    }

    setStudy(study) {
      this.study = study;
      this.studyHref = location.href;
      this.body.replaceChildren();
      const meta = document.createElement("div");
      meta.className = "rwj-dd-meta";
      const total = study.series.reduce((sum, item) => sum + item.imageCount, 0);
      for (const [label, value] of [
        ["检查日期", study.studyDate || "未知"],
        ["检查部位", study.studyDesc || "未知"],
        ["Series", `${study.series.length} 个`],
        ["影像", `${study.imageCount || total} 张`]
      ]) {
        const row = document.createElement("div");
        const labelNode = document.createElement("span");
        labelNode.textContent = label;
        const valueNode = document.createElement("b");
        valueNode.textContent = escapeText(value);
        row.append(labelNode, valueNode);
        meta.appendChild(row);
      }

      const list = document.createElement("div");
      list.className = "rwj-dd-series";
      study.series.forEach((series, index) => {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.dataset.index = String(index);
        const name = document.createElement("span");
        name.textContent = `${series.seriesNumber} ${series.seriesDes}`;
        const count = document.createElement("em");
        count.textContent = String(series.imageCount || "—");
        label.append(checkbox, name, count);
        list.appendChild(label);
      });

      const privacyWarning = document.createElement("div");
      privacyWarning.className = "rwj-dd-privacy-warning";
      privacyWarning.setAttribute("role", "alert");
      privacyWarning.textContent = "隐私提醒：下载的是未脱敏的原始 DICOM，影像及元数据可能包含患者个人信息；ZIP 文件名和序列目录也可能包含检查描述。请仅保存到可信设备，不要公开分享原始文件。";
      const warning = document.createElement("div");
      warning.className = "rwj-dd-warning";
      warning.textContent = "DICOM 会先保存在内存中再生成 ZIP；大型检查请确保浏览器有足够可用内存。";
      const download = document.createElement("button");
      download.type = "button";
      download.className = "rwj-dd-primary";
      download.textContent = "下载选中的 DICOM";
      download.addEventListener("click", () => this.startDownload());
      this.body.append(meta, list, privacyWarning, warning, download);
    }

    selectedSeries() {
      return [...this.body.querySelectorAll('.rwj-dd-series input[type="checkbox"]:checked')]
        .map((node) => this.study.series[Number(node.dataset.index)])
        .filter(Boolean);
    }

    async startDownload() {
      const selected = this.selectedSeries();
      if (!selected.length) return this.showTransientError("请至少选择一个 Series");
      this.busy = true;
      this.renderProgress({ phase: "prepare", completed: 0, total: selected.reduce((n, s) => n + s.imageCount, 0), failed: 0, bytes: 0 });
      try {
        const result = await this.handlers.download(this.study, selected, (state) => this.renderProgress(state));
        this.renderDone(result);
      } catch (error) {
        if (error?.name === "AbortError") {
          this.setStudy(this.study);
          this.showTransientError("下载已取消。");
        }
        else this.showError(error?.message || String(error));
      } finally {
        this.busy = false;
      }
    }

    showTransientError(message) {
      let node = this.body.querySelector(".rwj-dd-inline-error");
      if (!node) {
        node = document.createElement("div");
        node.className = "rwj-dd-inline-error";
        this.body.appendChild(node);
      }
      node.textContent = message;
    }

    renderProgress(state) {
      this.body.replaceChildren();
      const title = document.createElement("div");
      title.className = "rwj-dd-progress-title";
      title.textContent = state.phase === "zip" ? `正在生成 ZIP（${state.zipPercent || 0}%）` : "正在下载 DICOM";
      const progress = document.createElement("progress");
      progress.max = state.phase === "zip" ? 100 : Math.max(state.total || 1, 1);
      progress.value = state.phase === "zip" ? state.zipPercent || 0 : state.completed || 0;
      const details = document.createElement("div");
      details.className = "rwj-dd-progress-details";
      for (const text of [
        `进度：${state.completed || 0} / ${state.total || 0}`,
        `当前 Series：${state.currentSeries || "准备中"}`,
        `失败：${state.failed || 0}`,
        `已下载：${formatBytes(state.bytes || 0)}`
      ]) {
        const row = document.createElement("div");
        row.textContent = text;
        details.appendChild(row);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "rwj-dd-cancel";
      cancel.textContent = "取消";
      cancel.disabled = state.phase === "zip";
      cancel.addEventListener("click", () => this.handlers.cancel());
      this.body.append(title, progress, details, cancel);
    }

    renderDone(result) {
      this.body.replaceChildren();
      const done = document.createElement("div");
      done.className = "rwj-dd-done";
      done.textContent = `ZIP 已保存：${result.total - result.failures.length} 张成功，${result.failures.length} 张失败，共 ${formatBytes(result.bytes)}。`;
      const again = document.createElement("button");
      again.type = "button";
      again.textContent = "返回 Series 列表";
      again.addEventListener("click", () => this.setStudy(this.study));
      this.body.append(done, again);
    }
  }

  return { DownloaderUi, formatBytes };
});
