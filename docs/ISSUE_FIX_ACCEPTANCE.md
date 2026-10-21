# Issue fix acceptance

This change integrates the existing focused repairs for issues #3–#36 with
current mainline. The retired design-agent entry points and tools remain disabled.

| Issues | Corrected behavior | Regression coverage |
| --- | --- | --- |
| #3 | Insert replacement text literally, including JavaScript dollar patterns | `test/agent/tools.test.ts` |
| #4, #23 | Keep chat queues alive and stop failed startup clients | `test/feishu-bridge/chat-queue.test.ts`, `pi-client-retry.test.ts`, `test/scripts/feishu-queue-rejection.test.mjs` |
| #5, #10, #11, #17 | Honor explicit model selection, avoid bare-word routing, retain failed-turn context, and reset retry output | `test/agent/model-resolver.test.ts`, `pi-agent.test.ts`, `rpc-retry.test.ts`, `test/feishu-bridge/pi-client.test.ts` |
| #6, #18 | Accept attachment download navigation and retain multiline search snippets | `test/agent/browser-session-runtime.test.ts`, `web-search.test.ts`, `test/feishu-bridge/web-search.test.ts` |
| #7, #9, #15 | Discover recursive tests, build publishable artifacts, and declare the required Node version | `test/scripts/test-discovery.test.mjs`, `test/index.test.ts` |
| #8 | Abort timed-out benchmark requests and wait for settlement before reusing tools | `test/scripts/benchmark-timeout.test.mjs`, `test/agent/pi-agent.test.ts` |
| #12, #19, #32 | Bound streamed responses and cancel rejected bodies | `test/agent/network.test.ts`, `web-fetch.test.ts`, `paper-webpage-fetch.test.ts`, `web-search.test.ts` |
| #13, #16 | Preserve quote casing and bind benchmark responses to immutable content | `test/scripts/benchmark-quote-window.test.mjs`, `benchmark-identity.test.mjs` |
| #14, #30, #31, #36 | Preserve section boundaries, retry failed downloads, round-trip semicolons, and normalize arXiv subdomains | `test/agent/paper-reader.test.ts`, `paper-download-list.test.ts`, `arxiv.test.ts`, `paper-manager.test.ts` |
| #20 | Check PDF workspace containment and the opened file before upload | `test/feishu-bridge/pdf-delivery.test.ts` |
| #21 | Reject non-public targets, validate redirects, and pin direct/proxy transport to validated IP addresses | `test/agent/public-ip-policy.test.ts`, `public-url-policy.test.ts`, `web-fetch.test.ts` |
| #22 | Atomically persist memory, recover last-good backups, and preserve corrupt files | `test/feishu-bridge/atomic-json.test.ts` and the three memory-store suites |
| #24, #25 | Isolate stateless chats, coalesce startups, retain message leases, and bound idle clients | `test/feishu-bridge/pi-client-pool.test.ts`, `pi-session.test.ts` |
| #26 | Serialize message patches and await the final update | `test/feishu-bridge/stream-updater.test.ts` |
| #27 | Atomically replace wiki pages, index and metadata | `test/agent/wiki-atomic-write.test.ts` |
| #28, #29, #33, #34, #35 | Audit malformed pages, deduplicate evidence, retain aliases, and normalize link/section checks | `test/agent/wiki-review.test.ts`, `wiki-retrieval-contract.test.ts`, `wiki-maintenance.test.ts`, `wiki-page-templates.test.ts` |

Verification uses offline fixtures; no real model, publisher login, or Feishu
delivery is required. A passing regression suite does not claim production
provider authentication, live browser compatibility, or benchmark quality.

## Final verification

On Node 22.22.2, the final integrated source passed the actual `npm test` command:
**1024 passed**, zero failed, cancelled or skipped. Its recursive discovery covers
75 compiled TypeScript and 7 source MJS entries, including browser-extension.
The three follow-up candidates passed separate service-owned build/full-suite
checks and independent external review before explicit adoption. The combined
files match their adopted candidate blobs exactly.

From a missing `dist` tree, actual `npm pack` ran prepack/build and produced a
240-entry package containing the public JavaScript and declaration entry points.
The unpacked public API imported successfully. Three newly dispatched workers
ended normally; historical canceled tasks retain their original outcomes.

Benchmark results without the new content fingerprints require a rerun; old
results are not relabeled. Incomplete explicit model requests and non-public
web-fetch targets now fail explicitly. Runtime validation here used Linux;
Windows, the minimum declared Node version, and live external integrations were
not separately executed.
