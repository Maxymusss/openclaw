import { describe, expect, it } from "vitest";
import {
  repairRetiredModelSlots,
  type ModelRefRepairResolver,
} from "./retired-model-ref-repair.js";

describe("route-scoped retirement preserves alias ownership", () => {
  it.each([{ alias: "chat" }, { aliases: ["chat", "fast"] }])(
    "keeps %j on the original route while copying model settings",
    (names) => {
      const settings = { ...names, params: { temperature: 0.2 } };
      const owner = { model: { primary: "provider/old" }, models: { "provider/old": settings } };
      const warnings: string[] = [];
      const resolve: ModelRefRepairResolver = ({ modelRef }) =>
        modelRef === "provider/old"
          ? {
              kind: "replace",
              modelRef: "provider/new",
              reason: "retirement",
              retirementScope: "route",
            }
          : { kind: "unchanged" };

      repairRetiredModelSlots({ owner, path: "agents.defaults", resolve, changes: [], warnings });

      expect(owner.model.primary).toBe("provider/new");
      expect(owner.models).toEqual({
        "provider/old": settings,
        "provider/new": { params: { temperature: 0.2 } },
      });
      expect(warnings).toEqual([
        expect.stringContaining("Retained agents.defaults.models.provider/old alias"),
      ]);
    },
  );
});
