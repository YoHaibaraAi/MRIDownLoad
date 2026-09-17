const test = require("node:test");
const assert = require("node:assert/strict");

test("siteFetch reuses the page session authorization without persisting it", async () => {
  const originalFetch = global.fetch;
  const originalSessionStorage = global.sessionStorage;
  let capturedOptions;
  global.sessionStorage = { getItem: (key) => (key === "authorization" ? "test-session-value" : null) };
  global.fetch = async (_path, options) => {
    capturedOptions = options;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  delete require.cache[require.resolve("../src/api.js")];
  const api = require("../src/api.js");

  try {
    assert.deepEqual(await api.siteFetch("/dsiteapi/test"), { ok: true });
    assert.equal(capturedOptions.credentials, "include");
    assert.equal(capturedOptions.headers.Authorization, "test-session-value");
    assert.equal(capturedOptions.headers.secretType, "2");
  } finally {
    global.fetch = originalFetch;
    global.sessionStorage = originalSessionStorage;
  }
});

test("normalizeStudy keeps only download metadata", () => {
  const api = require("../src/api.js");
  assert.deepEqual(api.normalizeStudy({
    studyDate: 20260915,
    studyDesc: "L-ANKLE",
    paientName: "not-returned",
    selectedImageList: [{ seriesUid: "1.2.3", seriesNumber: 301, seriesDes: "Scout", imageCount: 9 }]
  }), {
    studyDate: "20260915",
    studyDesc: "L-ANKLE",
    imageCount: 9,
    domainId: "",
    series: [{ seriesUid: "1.2.3", seriesUidId: "", seriesNumber: 301, seriesDes: "Scout", imageCount: 9, fileSize: 0 }]
  });
});
