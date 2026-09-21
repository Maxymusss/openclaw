import { captureChatSessionScrollPosition, type ChatSessionScrollPosition } from "../scroll.ts";

export type TranscriptViewport = ChatSessionScrollPosition & {
  height: number;
  scrollHeight: number;
};

export function captureTranscriptViewport(element: HTMLElement): TranscriptViewport {
  const height = element.clientHeight;
  const scrollHeight = element.scrollHeight;
  return {
    ...captureChatSessionScrollPosition({
      clientHeight: height,
      scrollHeight,
      scrollTop: element.scrollTop,
    }),
    height,
    scrollHeight,
  };
}

export type TranscriptScrollObservation =
  | { type: "input"; event: Event; touching: boolean }
  | { type: "maintenance"; before: TranscriptViewport; after: TranscriptViewport }
  | {
      type: "offset";
      delta: number;
      scrolling: boolean;
      touching: boolean;
      programmatic: boolean;
    };

const transcriptObservers = new WeakMap<
  HTMLElement,
  Set<(event: TranscriptScrollObservation) => void>
>();

export function subscribeTranscriptScroll(
  element: HTMLElement,
  callback: (event: TranscriptScrollObservation) => void,
): () => void {
  const observers = transcriptObservers.get(element) ?? new Set();
  observers.add(callback);
  transcriptObservers.set(element, observers);
  return () => {
    observers.delete(callback);
    if (observers.size === 0) {
      transcriptObservers.delete(element);
    }
  };
}

export function publishTranscriptScroll(
  element: HTMLElement,
  event: TranscriptScrollObservation,
): void {
  for (const observer of transcriptObservers.get(element) ?? []) {
    observer(event);
  }
}
