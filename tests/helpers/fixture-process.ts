import { fork } from "node:child_process";
import { resolve } from "node:path";

export function startFixtureProcess(fault: boolean) {
  return new Promise<{ baseUrl: string; pid: number; close(): Promise<void> }>(
    (resolvePromise, reject) => {
      const child = fork(resolve("tests/helpers/fixture-child.ts"), [], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, PLAYTEST_FIXTURE_FAULT: fault ? "1" : "0" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("假服务启动超时"));
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("message", (message: { baseUrl: string; pid: number }) => {
        clearTimeout(timer);
        resolvePromise({
          ...message,
          close: () =>
            new Promise<void>((done) => {
              if (child.exitCode !== null) {
                done();
                return;
              }
              child.once("exit", () => done());
              child.send("stop");
            }),
        });
      });
    },
  );
}
