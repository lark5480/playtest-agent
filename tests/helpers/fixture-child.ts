import { startOthelloStubServer } from "../../src/demo/othello-server.js";

const server = await startOthelloStubServer(
  process.env.PLAYTEST_FIXTURE_FAULT === "1" ? { fault: "missed-flip" } : {},
);
process.send?.({ baseUrl: server.baseUrl, pid: process.pid });
process.on("message", async (message) => {
  if (message === "stop") {
    await server.close();
    process.disconnect?.();
  }
});
