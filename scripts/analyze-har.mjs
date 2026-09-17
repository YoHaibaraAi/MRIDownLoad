#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/analyze-har.mjs reference/file.har");
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(file, "utf8"));
const entries = har?.log?.entries ?? [];

function findEntry(part) {
  return entries.find(e => e?.request?.url?.includes(part));
}

function allEntries(part) {
  return entries.filter(e => e?.request?.url?.includes(part));
}

console.log(`HAR entries: ${entries.length}`);

const secret = findEntry("/dsiteapi/sm4/secret");
if (secret) {
  try {
    const body = JSON.parse(secret.response.content.text);
    const k = body.secretKey || "";
    console.log(`sm4/secret: found (${k.length} hex chars)`);
  } catch {
    console.log("sm4/secret: found, response not parsed");
  }
} else {
  console.log("sm4/secret: NOT FOUND");
}

const seriesInit = findEntry("QuerySeriesInfoByUrl");
if (seriesInit) {
  try {
    const arr = JSON.parse(seriesInit.response.content.text);
    const study = arr[0];
    const list = study?.selectedImageList ?? [];
    console.log(`study: ${study?.studyDate ?? "?"} ${study?.studyDesc ?? "?"}`);
    console.log(`series: ${list.length}, images: ${study?.imageCount ?? "?"}`);
    for (const s of list) {
      console.log(`  ${s.seriesNumber} ${s.seriesDes} -> ${s.imageCount}`);
    }
  } catch (e) {
    console.log("QuerySeriesInfoByUrl: found, parse failed:", e.message);
  }
} else {
  console.log("QuerySeriesInfoByUrl: NOT FOUND");
}

const listReq = allEntries("GetImageInfoBySeriesIds");
console.log(`GetImageInfoBySeriesIds requests: ${listReq.length}`);

const dicomReq = allEntries("GetImagePath2");
console.log(`GetImagePath2 requests: ${dicomReq.length}`);

let dicm = 0;
let binaryBodies = 0;

for (const e of dicomReq) {
  const content = e?.response?.content ?? {};
  const text = content.text;
  if (!text) continue;

  let buf;
  try {
    if (content.encoding === "base64") {
      buf = Buffer.from(text, "base64");
    } else {
      // HAR exporters differ. Try base64 first if it looks like it.
      try {
        buf = Buffer.from(text, "base64");
      } catch {
        buf = Buffer.from(text, "binary");
      }
    }
  } catch {
    continue;
  }

  binaryBodies += 1;
  if (buf.length >= 132 && buf.subarray(128, 132).toString("ascii") === "DICM") {
    dicm += 1;
  }
}

console.log(`DICOM response bodies present in HAR: ${binaryBodies}`);
console.log(`Bodies with DICM marker at offset 128: ${dicm}`);

const endpoints = [...new Set(entries
  .map(e => {
    try {
      const u = new URL(e.request.url);
      return `${e.request.method} ${u.pathname}`;
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter(x =>
    x.includes("/dsiteapi/") &&
    (
      x.includes("ImageSearch") ||
      x.includes("PatientThumbnails") ||
      x.includes("/sm4/")
    )
  )
)];

console.log("\nRelevant endpoints:");
for (const ep of endpoints) console.log(`  ${ep}`);
