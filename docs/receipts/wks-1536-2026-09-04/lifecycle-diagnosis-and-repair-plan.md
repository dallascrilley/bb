# WKS-1536 bounded lifecycle diagnosis and repair plan

Date: 2026-09-04

This report is a durable analysis of the existing WKS-1536 readback. It contains no credentials, tokens, secrets, raw interaction answers, or decision payloads. No provider or runtime source was changed for this report.

## Scope and verdict

WKS-1536 is a valid native interaction-resolution observation, but it is not a causal-resume observation. The original turn completed while its BB interaction remained pending. The native answer was submitted later and the interaction was then persisted as resolved. No post-answer execution event is evidenced for that turn.

The immediate observed failure is an ordering violation at the product boundary: provider turn completion was accepted before the pending interaction reached resolving or resolved. The exact low-level trigger is not established by the persisted event data.

## Authoritative chronology

All events below belong to thread `thr_98x25ybac2` and turn `dabccec608-t1`.

| Sequence | Event | Exact UTC timestamp |
| --- | --- | --- |
| 8 | Interaction became `pending` | `2026-09-04T19:01:02.777Z` |
| 17 | Turn became `completed` | `2026-09-04T19:04:23.415Z` |
| 18 | Interaction became `resolving` | `2026-09-04T19:44:57.227Z` |
| 19 | Interaction became `resolved` | `2026-09-04T19:44:57.240Z` |

The interaction readback reports `resolvedAt` as `2026-09-04T19:44:57.239Z`, which is 40 minutes 33.824 seconds after sequence 17. The returned event range ends at sequence 19. There is no later `turn/started`, item execution, assistant delta, item completion, or `turn/completed` event. The execution evidence at sequences 9–17 therefore predates persisted answer resolution.

Dallas's native submission, the empty pending list, the idle thread, and the completed turn remain original observations. This report changes only the causal wording: the native submission must not be described as having resumed this completed turn.

## Observed cause versus hypothesis

### Observed

1. The server persisted a provider `user_question` interaction as pending at sequence 8.
2. The provider-side item and assistant output completed before sequence 17, and the root turn was marked completed at the exact sequence-17 timestamp above.
3. The same interaction was not marked resolving until sequence 18 and resolved until sequence 19.
4. `apps/server/src/internal/turn-completed-events.ts` applies root `turn/completed` through the thread lifecycle independently of pending-interaction settlement.
5. `apps/server/src/services/interactions/pending-interactions.ts` changes an interaction to resolving, sends `interactive.resolve` to the host daemon, and marks it resolved from the command result. That is a separate path from turn completion.
6. `apps/host-daemon/src/interactive-request-registry.ts` waits on the provider request correlation and only resolves that waiter when the matching `interactive.resolve` arrives. Thread interruption is a separate operation.
7. `plugins/provider-claude-code/src/bridge/bridge.ts` keeps provider interactive requests in a bridge-local map. Its SDK abort handlers delete that local entry and resolve the SDK request with a denial; `createOnSdkDone` also calls `resolvePendingSessionWork`, which settles bridge-local pending work when the SDK stream ends. A provider response is decoded only while the bridge-local entry still exists.

These observations establish that the system has independently advancing provider, bridge, daemon, and server interaction state. They do not prove which callback or transport event caused this particular turn to complete.

### Hypothesis, not established fact

The leading hypothesis is that provider SDK query termination or cancellation occurred while `canUseTool` was awaiting the BB interaction. The bridge then cleaned up or denied its provider-side request, allowing the provider stream to finish, while the server row and daemon waiter remained pending until the later native resolution. The source code permits this mismatch, but the WKS-1536 persisted timeline does not record an SDK abort reason or prove that `onAbort` ran.

A second possibility is a transport or session split that delayed the server-to-host resolution path. It remains unproven because the durable receipt does not include provider/daemon wire logs. Neither hypothesis should be stated as the confirmed root cause until a focused regression reproduces the ordering.

## Legitimate task that can exercise causal resume

WKS-1536 cannot exercise causal resume now: its only turn is already completed, and there is no later execution event to resume. A read-only `bb thread count --status active --json` check returned zero at this investigation point, so no eligible active candidate is currently identified.

The eligible task must be an existing, legitimate BB-owned provider `user_question` interaction that is simultaneously:

- pending in the owner server;
- attached to an active original turn;
- correlated to a still-running provider session; and
- answerable through the authorized native/client path.

The owner/UI lane must nominate that task. Do not create a new fixture or submit another answer merely to manufacture causal evidence. The proof condition is an answer followed by a provider item or assistant execution event in the same original turn, then exactly one terminal completion. If no such current task exists, causal resume is not exercisable yet.

## Bounded repair plan

### 1. Add proof before changing lifecycle code

Reuse existing infrastructure only:

- Extend `plugins/provider-claude-code/src/bridge/__tests__/bridge.test.ts` with a controlled pending `canUseTool` request and provider stream-end/terminal ordering. Assert that unresolved interaction state cannot be silently converted into a completed provider turn.
- Extend the existing runtime interactive-request coverage under `packages/agent-runtime`, using `runtime-integration-harness.ts` and the existing interactive-request tests. Assert that the response remains correlated to the original provider request and that same-turn post-answer work occurs before one `turn/completed` event.
- Keep `packages/provider-bridge-protocol/recordings/claude-code/user-question` as the existing positive conformance oracle. Do not add a recording or fixture without coordination.
- Add a server-side invariant test only if the focused reproduction shows that server event application must reject or interrupt a terminal turn with an unresolved provider interaction. Use in-memory SQLite and migrations; do not mock the database.

### 2. Repair the provider/interaction boundary first

The smallest likely repair is in the Claude bridge lifecycle, not in `applyTurnCompletedEvent`:

- Preserve the provider-request correlation while the owner interaction is pending.
- Ensure benign SDK cleanup cannot deny the provider request while leaving the owner interaction pending.
- If the provider genuinely ends before resolution, propagate an explicit interaction interruption through the existing daemon/server lifecycle so no stale pending row or unresolved daemon waiter survives.
- Ensure a response arriving after provider termination is either handled by an explicit, tested continuation path or rejected as stale while the owner interaction is settled consistently. It must not be silently accepted as resume evidence.
- Do not suppress `turn/completed` without a corresponding provider continuation mechanism; that would hide the ordering defect and leave the provider state ambiguous.

If the repair requires a new host-daemon or bridge wire message, increment `HOST_DAEMON_PROTOCOL_VERSION` and test old/new message rejection. If the existing interruption path is sufficient, avoid adding a new protocol surface.

### 3. Acceptance criteria

A repair is ready for a real current task only when existing tests and the authorized observation show all of the following:

1. Pending interaction registration occurs inside the active turn.
2. No terminal turn event is emitted while the provider request remains unresolved.
3. The native answer resolves the exact original interaction and provider request once.
4. The provider emits post-answer execution in that same turn.
5. The turn completes once after that execution.
6. Provider termination before answer settles the interaction as interrupted or otherwise terminal through the owner lifecycle, with no stale pending state.
7. The receipt separately records answer delivery, execution-after-answer, and OS notification observation. A delivery acknowledgment alone is insufficient.

Until these conditions are met, retain WKS-1536 as **In Progress**, retain the corrected receipt wording, and keep OS notification display/click-through unverified.
