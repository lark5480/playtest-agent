import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function runCli(
  command: string,
  args: readonly string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", resolve("src/cli.ts"), command, ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, AI_API_BASE: "", AI_API_KEY: "", AI_MODEL: "", ...extraEnv },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI超时：${command}`));
      }, 30_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stdout, stderr });
      });
    },
  );
}
