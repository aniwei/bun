/**
 * HdrHistogram_c — high-dynamic-range latency histogram. Used by bun test's
 * per-test timing output and benchmark reporting.
 */

import type { Dependency } from "../source.ts";

const HDRHISTOGRAM_COMMIT = "30e9ce6ef5dcdc60f9270e1ca03c0966eaaf71d0";

export const hdrhistogram: Dependency = {
  name: "hdrhistogram",

  source: () => ({
    kind: "github-archive",
    repo: "HdrHistogram/HdrHistogram_c",
    commit: HDRHISTOGRAM_COMMIT,
  }),

  build: () => ({
    kind: "nested-cmake",
    args: {
      HDR_HISTOGRAM_BUILD_SHARED: "OFF",
      HDR_HISTOGRAM_BUILD_STATIC: "ON",
      // Disables the zlib-dependent log writer. We only need the in-memory
      // histogram API — serialization goes through our own code.
      HDR_LOG_REQUIRED: "DISABLED",
      HDR_HISTOGRAM_BUILD_PROGRAMS: "OFF",
    },
    libSubdir: "src",
  }),

  provides: () => ({
    libs: ["hdr_histogram_static"],
    includes: ["include"],
  }),
};
