import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const help = `Usage: node scripts/validate-bb-resume-receipt.mjs <receipt.json>
Checks sanitized chronology, not authenticity or physical notification delivery.
Receipt: { threadId, turnId, interactionId, events: [...] }.
Exactly five events, in order: pending, nativeAnswer, ownerAccepted, execution, completed.
Every event needs matching threadId/turnId/interactionId, a unique evidenceRef,
and timestamp in canonical UTC ISO form YYYY-MM-DDTHH:mm:ss.sssZ.
Owner events need increasing positive integer sourceSeq from the same thread stream.
nativeAnswer has no sourceSeq; its timestamp must precede owner acceptance.
execution identifies a post-answer provider execution event, not a status snapshot.
Use source evidence references; never construct events from success booleans.
`;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error("timestamp must be an unambiguous canonical UTC instant");
  }
  return Date.parse(value);
}

function identifier(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw new Error(`${label} must be a nonempty identifier`);
  }
  return value;
}

export function validateResumeReceipt(input) {
  const receipt = record(input, "receipt");
  if (receipt.lifecycleCorrection) {
    const lifecycle = record(
      receipt.lifecycleCorrection,
      "lifecycleCorrection",
    );
    const completed = record(lifecycle.turnCompleted, "turnCompleted");
    const resolved = record(
      lifecycle.interactionResolved,
      "interactionResolved",
    );
    if (timestamp(completed.timestamp) <= timestamp(resolved.timestamp)) {
      throw new Error(
        "original turn completed before owner resolution; no post-answer continuation proved",
      );
    }
    throw new Error(
      "legacy timeline lacks explicit target-bound execution evidence",
    );
  }
  const target = Object.fromEntries(
    ["threadId", "turnId", "interactionId"].map((key) => [
      key,
      identifier(receipt[key], key),
    ]),
  );
  const kinds = [
    "pending",
    "nativeAnswer",
    "ownerAccepted",
    "execution",
    "completed",
  ];
  if (
    !Array.isArray(receipt.events) ||
    receipt.events.length !== kinds.length
  ) {
    throw new Error(
      "exactly five lifecycle events are required, including post-answer execution",
    );
  }
  let previousTime = -Infinity;
  let previousSeq = 0;
  const references = new Set();
  for (const [index, value] of receipt.events.entries()) {
    const event = record(value, "event");
    if (event.kind !== kinds[index]) {
      throw new Error(`expected ${kinds[index]} event at position ${index}`);
    }
    for (const [key, expected] of Object.entries(target)) {
      if (event[key] !== expected)
        throw new Error(`${event.kind} ${key} differs from original target`);
    }
    const reference = identifier(event.evidenceRef, "evidenceRef");
    if (references.has(reference)) throw new Error("duplicate evidenceRef");
    references.add(reference);
    const time = timestamp(event.timestamp);
    if (time <= previousTime)
      throw new Error("events must have strictly increasing timestamps");
    previousTime = time;
    if (event.kind === "nativeAnswer") {
      if (Object.hasOwn(event, "sourceSeq"))
        throw new Error("nativeAnswer must not claim an owner sourceSeq");
    } else {
      if (
        !Number.isSafeInteger(event.sourceSeq) ||
        event.sourceSeq <= previousSeq
      ) {
        throw new Error(
          "owner sourceSeq must be positive and strictly increasing",
        );
      }
      previousSeq = event.sourceSeq;
    }
  }
  return target;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(help);
  } else if (args.length !== 1 || args[0].startsWith("-")) {
    process.stderr.write(help);
    process.exitCode = 2;
  } else {
    try {
      validateResumeReceipt(JSON.parse(readFileSync(args[0], "utf8")));
      process.stdout.write(
        "PASS: target-bound post-answer chronology; live evidence authenticity still requires review.\n",
      );
    } catch (error) {
      process.stderr.write(`FAIL: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
