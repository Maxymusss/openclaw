import { afterAll } from "vitest";

afterAll(() => {
  const capture = Reflect.get(globalThis, Symbol.for("f113.capture"));
  if (typeof capture === "function") capture("afterAll");
});
