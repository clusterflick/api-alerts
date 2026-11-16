import { expect, it } from "vitest";
import * as entry from "../src/index";

// workerd refuses an entry module exporting anything but handlers, which
// only shows on deploy or under `wrangler dev`, not in these tests.
it("exports only the Worker's handlers", () => {
  expect(Object.keys(entry)).toEqual(["default"]);
});
