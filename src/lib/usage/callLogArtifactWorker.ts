import { parentPort } from "node:worker_threads";

import {
  applyWriteEnvironment,
  writeCallArtifact,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
  type CallLogWriteEnvironment,
} from "./callLogArtifacts.ts";

type WriteRequest = {
  id: number;
  artifact: CallLogArtifact;
  environment: CallLogWriteEnvironment;
};

type WriteReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
};

parentPort?.on("message", (request: WriteRequest) => {
  const originalConsoleError = console.error;
  let result: CallLogArtifactWriteResult | null = null;

  try {
    // The writer reads these options lazily; mirror the caller's per-write environment snapshot.
    applyWriteEnvironment(request.environment);
    // writeCallArtifact's legacy error includes filesystem paths. Keep worker failures generic.
    console.error = () => {};
    result = writeCallArtifact(request.artifact);
  } catch {
    result = null;
  } finally {
    console.error = originalConsoleError;
  }

  try {
    parentPort?.postMessage({ id: request.id, result } satisfies WriteReply);
  } catch {
    parentPort?.postMessage({ id: request.id, result: null } satisfies WriteReply);
  }
});
