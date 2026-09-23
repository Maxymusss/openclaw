/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptPerformanceMessages } from "../../../test-helpers/chat-transcript-performance.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import * as positionProjection from "./chat-position-projection.ts";
import * as messageIndex from "./chat-transcript-message-index.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

describe("chat transcript derivation", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["agent:main:dashboard:projection", "agent:main:telegram:group:projection"])(
    "reuses history rows and indexes across live deltas in %s, then publishes a prepend together",
    (sessionKey) => {
      let historyReads = 0;
      const history = createTranscriptPerformanceMessages(1_000);
      const messages = new Proxy(history, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            historyReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const props = {
        ...threadProps(`pane-${sessionKey}`, sessionKey, messages),
        runId: "live-run",
        runActive: true,
        runWorking: true,
        stream: "Live answer",
        streamStartedAt: 1_700_001_001_000,
      };
      const transcript = createTestTranscript();
      try {
        transcript.renderSession(props.paneId, props.sessionKey, (session) => {
          const renderRows = vi.spyOn(session, "render");
          const indexes = vi.spyOn(messageIndex, "projectTranscriptMessageIndex");
          const positions = vi.spyOn(positionProjection, "projectChatPositions");
          const initial = projectChatTranscript(props, session);
          initial.renderRows();
          const initialRows = renderRows.mock.calls.at(-1)?.[0];
          expect(historyReads).toBeGreaterThanOrEqual(history.length);
          historyReads = 0;
          indexes.mockClear();
          positions.mockClear();

          for (let delta = 0; delta < 5; delta += 1) {
            props.stream += ` delta ${delta}`;
            const next = projectChatTranscript(props, session);
            next.renderRows();
            expect(next.positionIndex).toBe(initial.positionIndex);
            expect(renderRows.mock.calls.at(-1)?.[0]).toBe(initialRows);
            expect(next.positionIndex.markers.at(-1)?.message).toMatchObject({
              content: [{ type: "text", text: props.stream }],
            });
          }
          expect(historyReads).toBe(0);
          expect(indexes).not.toHaveBeenCalled();
          expect(positions).not.toHaveBeenCalled();

          props.messages = [
            { role: "user", content: "Older", timestamp: 0, __openclaw: { id: "older" } },
            ...history,
          ];
          const prepended = projectChatTranscript(props, session);
          prepended.renderRows();
          expect(prepended.positionIndex).not.toBe(initial.positionIndex);
          expect(prepended.positionIndex.markers[0]?.anchorId).toBe("older");
          expect(renderRows.mock.calls.at(-1)?.[0]).not.toBe(initialRows);
          expect(indexes).toHaveBeenCalledTimes(1);
          expect(positions).toHaveBeenCalledTimes(1);
          return html``;
        });
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("keeps shared-history pane projections separate and releases them on disconnect", () => {
    const messages = createTranscriptPerformanceMessages(4);
    const props = ["left", "right"].map((paneId) =>
      Object.assign(threadProps(paneId, "agent:main:dashboard:shared", messages), {
        runId: "shared-run",
        runActive: true,
        runWorking: true,
        stream: "Initial reply",
        streamStartedAt: 1_700_001_001_000,
      }),
    );
    const transcripts = props.map(() => createTestTranscript());
    const project = (index: number) => {
      let projection: ReturnType<typeof projectChatTranscript> | undefined;
      transcripts[index]!.renderSession(
        props[index]!.paneId,
        props[index]!.sessionKey,
        (session) => {
          projection = projectChatTranscript(props[index]!, session);
          return html``;
        },
      );
      return expectDefined(projection, "pane projection");
    };
    try {
      const left = project(0);
      const right = project(1);
      expect(left.positionIndex).not.toBe(right.positionIndex);
      props[0]!.stream = "Advanced reply";
      expect(project(0).positionIndex).toBe(left.positionIndex);
      expect(right.positionIndex.markers.at(-1)?.message).toMatchObject({
        content: [{ type: "text", text: "Initial reply" }],
      });
      transcripts[0]!.hostDisconnected();
      expect(project(0).positionIndex).not.toBe(left.positionIndex);
      expect(project(1).positionIndex).toBe(right.positionIndex);
    } finally {
      transcripts.forEach((transcript) => transcript.hostDisconnected());
    }
  });
});
