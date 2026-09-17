(function initApi(root, factory) {
  const api = factory(root.RWJSM4);
  root.RWJApi = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function makeApi(sm4) {
  "use strict";

  const API_ROOT = "/dsiteapi";
  const JSON_HEADERS = {
    secretType: "2",
    "X-Requested-With": "XMLHttpRequest"
  };

  function debug(...args) {
    try {
      if (localStorage.getItem("RWJ_DICOM_DEBUG") === "1") console.debug("[RWJ-DICOM]", ...args);
    } catch (_) {
      // Storage can be unavailable in hardened browsing modes.
    }
  }

  function getPageAuthorization() {
    try {
      return sessionStorage.getItem("authorization") || "";
    } catch (_) {
      return "";
    }
  }

  async function siteFetch(path, options = {}) {
    const { method = "GET", responseType = "json", signal } = options;
    const authorization = getPageAuthorization();
    const response = await fetch(path, {
      method,
      credentials: "include",
      headers: {
        ...JSON_HEADERS,
        ...(authorization ? { Authorization: authorization } : {}),
        ...(method === "POST" ? { "Content-Type": "application/json;charset=UTF-8" } : {})
      },
      signal
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    if (responseType === "arrayBuffer") {
      return {
        data: await response.arrayBuffer(),
        contentType: response.headers.get("content-type") || ""
      };
    }
    try {
      return await response.json();
    } catch (_) {
      throw new Error("服务器返回了无法解析的数据");
    }
  }

  function collectLocationParams(href) {
    const pageUrl = new URL(href);
    const params = new URLSearchParams(pageUrl.search);
    const queryIndex = pageUrl.hash.indexOf("?");
    if (queryIndex >= 0) {
      const hashParams = new URLSearchParams(pageUrl.hash.slice(queryIndex + 1));
      for (const [key, value] of hashParams) if (!params.has(key)) params.set(key, value);
    }
    return params;
  }

  function asArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.result)) return payload.result;
    return payload && typeof payload === "object" ? [payload] : [];
  }

  function normalizeSeries(item, index = 0) {
    if (!item || typeof item !== "object") return null;
    const seriesUid = item.seriesUid ?? item.seriesUID ?? item.SeriesInstanceUID;
    if (!seriesUid) return null;
    const seriesNumber = item.seriesNumber ?? item.seriesNo ?? item.SeriesNumber ?? index + 1;
    return {
      seriesUid: String(seriesUid),
      seriesUidId: item.seriesUidId ?? item.seriesID ?? item.id ?? "",
      seriesNumber: Number.isFinite(Number(seriesNumber)) ? Number(seriesNumber) : index + 1,
      seriesDes: String(item.seriesDes ?? item.seriesDesc ?? item.description ?? `Series ${seriesNumber}`),
      imageCount: Number(item.imageCount ?? item.imagesCount ?? item.count ?? 0) || 0,
      fileSize: Number(item.fileSize ?? 0) || 0
    };
  }

  function normalizeStudy(item) {
    if (!item || typeof item !== "object") throw new Error("未找到当前检查信息");
    const rawSeries = item.selectedImageList ?? item.seriesList ?? item.series ?? [];
    const series = asArray(rawSeries).map(normalizeSeries).filter(Boolean);
    return {
      studyDate: String(item.studyDate ?? item.checkDate ?? ""),
      studyDesc: String(item.studyDesc ?? item.checkPart ?? "未命名检查"),
      imageCount: Number(item.imageCount ?? series.reduce((sum, value) => sum + value.imageCount, 0)) || 0,
      domainId: String(item.domainId ?? ""),
      series
    };
  }

  async function getStudyFromCurrentUrl(href, signal) {
    const params = collectLocationParams(href);
    if (!params.get("studyUid")) throw new Error("当前页面 URL 中没有 studyUid");
    params.set("random", String(Date.now()));
    const payload = await siteFetch(`${API_ROOT}/ImageSearch/QuerySeriesInfoByUrl?${params}`, { signal });
    const study = asArray(payload)[0];
    const normalized = normalizeStudy(study);
    if (!normalized.series.length) throw new Error("当前检查没有可下载的 Series");
    return normalized;
  }

  async function getStaticKey(signal) {
    const payload = await siteFetch(`${API_ROOT}/sm4/secret`, { method: "POST", signal });
    const key = payload?.secretKey ?? payload?.data?.secretKey;
    if (typeof key !== "string" || !/^[0-9a-f]{32}$/i.test(key)) throw new Error("staticKey 获取失败");
    return key;
  }

  function createClient(context) {
    const key = context.staticKey;
    if (typeof key !== "string" || !/^[0-9a-f]{32}$/i.test(key)) throw new Error("staticKey 无效");
    const encrypt = (value) => sm4.encryptText(value == null ? "" : String(value), key);
    const common = () => ({
      domainId: encrypt(context.domainId || ""),
      ae: encrypt(context.curSerieAe || "")
    });

    return {
      async getInstances(series, signal) {
        const uids = series.map((item) => item.seriesUid).filter(Boolean);
        if (!uids.length) throw new Error("没有选中的 Series");
        const params = new URLSearchParams({ seriesUidIds: encrypt(uids.join(",")), ...common() });
        const payload = await siteFetch(`${API_ROOT}/PatientThumbnails/GetImageInfoBySeriesIds?${params}`, { signal });
        if (!Array.isArray(payload) && payload?.code != null) {
          const message = payload.msg === "LOGIN_SESSION_OUT"
            ? "页面会话已失效，请刷新影像页面后重试"
            : `获取 DICOM Instance 失败：${payload.msg || `code ${payload.code}`}`;
          throw new Error(message);
        }
        const groups = asArray(payload).map((group) => ({
          seriesUid: String(group?.seriesUid ?? ""),
          imageBeans: asArray(group?.imageBeans).filter((item) => item?.instanceUid && item?.seriesUid)
        }));
        debug("已获取 Instance 列表", { seriesCount: groups.length, imageCount: groups.reduce((n, g) => n + g.imageBeans.length, 0) });
        return groups;
      },

      async downloadDicom(instance, signal) {
        const params = new URLSearchParams({
          instanceUid: encrypt(instance.instanceUid),
          seriesUid: encrypt(instance.seriesUid),
          ...common()
        });
        return siteFetch(`${API_ROOT}/PatientThumbnails/GetImagePath2?${params}`, {
          responseType: "arrayBuffer",
          signal
        });
      }
    };
  }

  return { createClient, getStaticKey, getStudyFromCurrentUrl, normalizeSeries, normalizeStudy, siteFetch };
});
