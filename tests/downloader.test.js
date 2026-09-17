const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const { DownloadManager, makeZipName, sanitizePathSegment, sortByImageNumber } = require("../src/downloader.js");

test("sanitizePathSegment removes unsafe ZIP path characters", () => {
  assert.equal(sanitizePathSegment('PD/Sag:*?"<>|'), "PD_Sag_______");
  assert.equal(sanitizePathSegment("   ", "series_7"), "series_7");
  assert.equal(sanitizePathSegment("a".repeat(100)).length, 80);
});

test("sortByImageNumber sorts numerically without mutating input", () => {
  const input = [{ imageNumber: 10 }, { imageNumber: 2 }, { imageNumber: 1 }];
  const sorted = sortByImageNumber(input);
  assert.deepEqual(sorted.map((item) => item.imageNumber), [1, 2, 10]);
  assert.deepEqual(input.map((item) => item.imageNumber), [10, 2, 1]);
});

test("ZIP filename uses the sanitized study description", () => {
  assert.equal(makeZipName({ studyDate: 20260915, studyDesc: "L/ANKLE" }), "20260915_L_ANKLE_DICOM.zip");
});

test("DownloadManager retries, sorts, and writes selected Series folders", async () => {
  let transientAttempts = 0;
  const dicom = new Uint8Array(140);
  dicom.set(Buffer.from("DICM"), 128);
  const client = {
    async getInstances() {
      return [{
        seriesUid: "series-a",
        imageBeans: [
          { seriesUid: "series-a", instanceUid: "instance-2", imageNumber: 2 },
          { seriesUid: "series-a", instanceUid: "instance-1", imageNumber: 1 }
        ]
      }];
    },
    async downloadDicom(instance) {
      if (instance.instanceUid === "instance-1" && transientAttempts++ === 0) throw new Error("transient");
      return { data: dicom.buffer.slice(0), contentType: "application/octet-stream" };
    }
  };
  const manager = new DownloadManager({ client, concurrency: 2, maxRetries: 1, zipFactory: () => new JSZip() });
  const result = await manager.run(
    { studyDate: 20260915, studyDesc: "L/ANKLE" },
    [{ seriesUid: "series-a", seriesNumber: 301, seriesDes: "PD/Sag" }]
  );
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  assert.ok(zip.file("301_PD_Sag/001.dcm"));
  assert.ok(zip.file("301_PD_Sag/002.dcm"));
  assert.equal(result.failures.length, 0);
  assert.equal(result.bytes, 280);
  assert.equal(transientAttempts, 2);
});
