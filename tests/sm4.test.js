const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sm4 = require("../src/sm4.js");

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/sm4-vectors.json"), "utf8"));

for (const vector of vectors.vectors) {
  test(`SM4 vector: ${vector.note}`, () => {
    assert.equal(sm4.encryptText(vector.plaintext, vector.key_hex), vector.ciphertext_hex);
  });
}

test("site helper preserves empty-string behavior", () => {
  assert.equal(sm4.encryptText("", vectors.vectors[0].key_hex), vectors.helper_empty_string_behavior);
});

test("frontend stringifies an undefined AE argument", () => {
  assert.equal(
    sm4.encryptText("undefined", vectors.vectors[0].key_hex),
    vectors.undefined_ciphertext_hex
  );
});

test("SM4 rejects malformed keys", () => {
  assert.throws(() => sm4.encryptText("hello", "not-a-key"), /32 hexadecimal/);
});
