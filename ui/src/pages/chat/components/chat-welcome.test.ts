import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderWelcomeState } from "./chat-welcome.ts";

describe("chat welcome model setup", () => {
  it.each([true, false])("keeps the draft chooser usable with setup guidance: %s", (required) => {
    const choose = vi.fn();
    const setup = vi.fn();
    const root = document.createElement("div");
    render(
      renderWelcomeState({
        assistantName: "Assistant",
        assistantAvatar: null,
        modelSetupRequired: required,
        onModelSetup: setup,
        composer: html`<button data-draft-chooser @click=${choose}>Choose approved model</button>`,
        onDraftChange: vi.fn(),
        onSend: vi.fn(),
      }),
      root,
    );
    const chooser = root.querySelector<HTMLButtonElement>("[data-draft-chooser]");
    expect(chooser).not.toBeNull();
    chooser!.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(root.querySelector('[role="alert"]') !== null).toBe(required);
    expect(setup).not.toHaveBeenCalled();
  });
});
