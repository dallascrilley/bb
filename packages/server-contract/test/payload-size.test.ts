import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  computeTimelineRowDelta,
  type TimelineRow,
} from "../src/thread-timeline.js";

interface PayloadSize {
  gzipBytes: number;
  jsonBytes: number;
}

function payloadSize(value: unknown): PayloadSize {
  const json = JSON.stringify(value);
  return {
    gzipBytes: gzipSync(json).byteLength,
    jsonBytes: Buffer.byteLength(json),
  };
}

function row(index: number, detail = "stable"): TimelineRow {
  return {
    id: `timeline-row-${String(index).padStart(4, "0")}`,
    kind: "system",
    threadId: "thr_payload_measurement_123456789",
    turnId: "turn_payload_measurement_123456789",
    sourceSeqStart: index + 1,
    sourceSeqEnd: index + 1,
    startedAt: 1_750_000_000_000 + index,
    createdAt: 1_750_000_000_000 + index,
    systemKind: "debug",
    title: `Timeline measurement row ${index}`,
    detail,
    status: null,
  };
}

describe("server-to-browser timeline payload sizes", () => {
  it("records full and single-row delta sizes across representative windows", () => {
    const measurements = [1, 20, 100].map((rowCount) => {
      const previous = Array.from({ length: rowCount }, (_, index) =>
        row(index),
      );
      const current = previous.map((item, index) =>
        index === rowCount - 1
          ? row(index, "streamed update ".repeat(20))
          : item,
      );
      const compactDelta = computeTimelineRowDelta(previous, current);
      const legacyDelta = {
        ...compactDelta,
        rowOrder: current.map((item) => item.id),
      };
      return {
        rowCount,
        full: payloadSize(current),
        legacyDelta: payloadSize(legacyDelta),
        compactDelta: payloadSize(compactDelta),
      };
    });

    expect(
      measurements.map(({ rowCount, full, legacyDelta, compactDelta }) => ({
        rowCount,
        fullJsonBytes: full.jsonBytes,
        legacyDeltaJsonBytes: legacyDelta.jsonBytes,
        compactDeltaJsonBytes: compactDelta.jsonBytes,
      })),
    ).toEqual([
      {
        rowCount: 1,
        fullJsonBytes: 629,
        legacyDeltaJsonBytes: 677,
        compactDeltaJsonBytes: 644,
      },
      {
        rowCount: 20,
        fullJsonBytes: 6_627,
        legacyDeltaJsonBytes: 1_060,
        compactDeltaJsonBytes: 647,
      },
      {
        rowCount: 100,
        fullJsonBytes: 31_989,
        legacyDeltaJsonBytes: 2_662,
        compactDeltaJsonBytes: 649,
      },
    ]);

    // Deflate output sizes vary across zlib implementations. Keep the stable
    // JSON-size regression contract exact and assert only implementation-
    // independent properties of compressed payloads.
    for (const measurement of measurements) {
      for (const payload of [
        measurement.full,
        measurement.legacyDelta,
        measurement.compactDelta,
      ]) {
        expect(payload.gzipBytes).toBeGreaterThan(0);
        expect(payload.gzipBytes).toBeLessThan(payload.jsonBytes);
      }
      expect(measurement.compactDelta.jsonBytes).toBeLessThanOrEqual(
        measurement.legacyDelta.jsonBytes,
      );
    }
  });
});
