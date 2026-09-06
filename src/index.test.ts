import { expect, test } from "vitest";
import { VERSION } from "./index.js";

test("package exposes a version string", () => {
  expect(VERSION).toBe("0.0.0");
});
