import { describe, expect, it } from "vite-plus/test";
import { healthResponse } from "./health";

describe("health API", () => {
  it("returns a successful JSON response from Effect", async () => {
    const response = await healthResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      message: "Hello from the Effect backend!",
      timestamp: expect.any(String),
    });
  });
});
