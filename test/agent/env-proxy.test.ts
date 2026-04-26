import test from "node:test";
import assert from "node:assert/strict";
import { getEnvProxyUrl } from "../../src/agent/env-proxy.js";

test("getEnvProxyUrl prefers HTTPS proxy variables", () => {
  assert.equal(
    getEnvProxyUrl({
      HTTP_PROXY: "http://proxy-http.example:8080",
      HTTPS_PROXY: "http://proxy-https.example:8080"
    }),
    "http://proxy-https.example:8080"
  );
});

test("getEnvProxyUrl falls back to lowercase proxy variables", () => {
  assert.equal(
    getEnvProxyUrl({
      http_proxy: "http://proxy-http.example:8080"
    }),
    "http://proxy-http.example:8080"
  );
});

test("getEnvProxyUrl ignores blank proxy variables", () => {
  assert.equal(
    getEnvProxyUrl({
      HTTPS_PROXY: "   ",
      HTTP_PROXY: ""
    }),
    undefined
  );
});
