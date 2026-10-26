import { expect, test } from "bun:test";
import { onlyWaits } from "./index.ts";

const post = (body: unknown) =>
  new Request("http://127.0.0.1/mcp", { method: "POST", body: JSON.stringify(body) });
const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });

test("a call that only waits for the person isn't work", async () => {
  expect(await onlyWaits(post(call("wait_for_activity")))).toBe(true);
  expect(await onlyWaits(post(call("screenshot")))).toBe(false);
  expect(await onlyWaits(post([call("wait_for_activity"), call("write_html")]))).toBe(false);
  expect(await onlyWaits(post({ jsonrpc: "2.0", id: 1, method: "initialize" }))).toBe(false);
  // The body stays readable for the transport.
  const req = post(call("wait_for_activity"));
  await onlyWaits(req);
  expect(((await req.json()) as { method: string }).method).toBe("tools/call");
});
