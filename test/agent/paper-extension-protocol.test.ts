import assert from "node:assert/strict";
import test from "node:test";
import {
  parseExtensionHostMessage,
  parseExtensionHostResponse
} from "../../src/agent/paper-extension-protocol.js";

test("parseExtensionHostMessage accepts register_download messages", () => {
  const message = parseExtensionHostMessage({
    type: "register_download",
    jobId: "job-123",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    downloadPath: "downloads/papers/science-paper.pdf",
    title: "Science Paper"
  });

  assert.deepEqual(message, {
    type: "register_download",
    jobId: "job-123",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    downloadPath: "downloads/papers/science-paper.pdf",
    title: "Science Paper"
  });
});

test("parseExtensionHostMessage accepts job_status messages", () => {
  const message = parseExtensionHostMessage({
    type: "job_status",
    jobId: "job-123",
    status: "pdf_candidate_found",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    message: "PDF link detected."
  });

  assert.deepEqual(message, {
    type: "job_status",
    jobId: "job-123",
    status: "pdf_candidate_found",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    message: "PDF link detected."
  });
});

test("parseExtensionHostMessage accepts poll_jobs messages", () => {
  const message = parseExtensionHostMessage({
    type: "poll_jobs",
    extensionInstanceId: "extension-abc"
  });

  assert.deepEqual(message, {
    type: "poll_jobs",
    extensionInstanceId: "extension-abc"
  });
});

test("parseExtensionHostMessage rejects register_download messages missing downloadPath", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "register_download",
        jobId: "job-123",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        source: "science"
      }),
    /downloadPath/i
  );
});

test("parseExtensionHostMessage rejects non-object input", () => {
  assert.throws(() => parseExtensionHostMessage("not an object"), /object/i);
});

test("parseExtensionHostMessage rejects blank required strings", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "poll_jobs",
        extensionInstanceId: " "
      }),
    /extensionInstanceId/i
  );
});

test("parseExtensionHostMessage rejects invalid PaperSource values", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "register_download",
        jobId: "job-123",
        articleUrl: "https://example.com/paper",
        source: "publisher",
        downloadPath: "downloads/papers/paper.pdf"
      }),
    /source/i
  );
});

test("parseExtensionHostMessage rejects invalid job statuses", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "job_status",
        jobId: "job-123",
        status: "started",
        articleUrl: "https://example.com/paper"
      }),
    /status/i
  );
});

test("parseExtensionHostResponse accepts jobs responses with queued job payloads", () => {
  const response = parseExtensionHostResponse({
    type: "jobs",
    jobs: [
      {
        jobId: "job-123",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        source: "arxiv",
        title: "Queued Paper",
        autoClose: true
      }
    ]
  });

  assert.deepEqual(response, {
    type: "jobs",
    jobs: [
      {
        jobId: "job-123",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        source: "arxiv",
        title: "Queued Paper",
        autoClose: true
      }
    ]
  });
});

test("parseExtensionHostResponse rejects invalid optional booleans", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "jobs",
        jobs: [
          {
            jobId: "job-123",
            articleUrl: "https://arxiv.org/abs/2401.01234",
            source: "arxiv",
            autoClose: "yes"
          }
        ]
      }),
    /autoClose/i
  );
});

test("parseExtensionHostResponse accepts registered responses", () => {
  const response = parseExtensionHostResponse({
    type: "registered",
    jobId: "job-123",
    articleUrl: "https://example.com/paper",
    downloadPath: "downloads/papers/external-paper.pdf",
    recordPath: "downloads/papers/index/external-paper.json",
    fileSha256: "abc123",
    title: "External Paper"
  });

  assert.deepEqual(response, {
    type: "registered",
    jobId: "job-123",
    articleUrl: "https://example.com/paper",
    downloadPath: "downloads/papers/external-paper.pdf",
    recordPath: "downloads/papers/index/external-paper.json",
    fileSha256: "abc123",
    title: "External Paper"
  });
});

test("parseExtensionHostResponse accepts status_ack responses", () => {
  const response = parseExtensionHostResponse({
    type: "status_ack",
    jobId: "job-123",
    status: "downloaded"
  });

  assert.deepEqual(response, {
    type: "status_ack",
    jobId: "job-123",
    status: "downloaded"
  });
});

test("parseExtensionHostResponse rejects status_ack responses with invalid statuses", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "status_ack",
        jobId: "job-123",
        status: "complete"
      }),
    /status/i
  );
});

test("parseExtensionHostResponse accepts error responses", () => {
  const response = parseExtensionHostResponse({
    type: "error",
    jobId: "job-123",
    code: "invalid_message",
    message: "downloadPath is required."
  });

  assert.deepEqual(response, {
    type: "error",
    jobId: "job-123",
    code: "invalid_message",
    message: "downloadPath is required."
  });
});

test("parseExtensionHostResponse rejects error responses missing code", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        message: "downloadPath is required."
      }),
    /code/i
  );
});

test("parseExtensionHostResponse rejects error responses missing message", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        code: "invalid_message"
      }),
    /message/i
  );
});

test("parseExtensionHostResponse rejects error responses with blank code", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        code: " ",
        message: "downloadPath is required."
      }),
    /code/i
  );
});

test("parseExtensionHostResponse rejects error responses with blank message", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        code: "invalid_message",
        message: " "
      }),
    /message/i
  );
});
