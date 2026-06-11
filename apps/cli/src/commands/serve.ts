import { startServer } from "@seekforge/server";

export type ServeOptions = {
  port: number;
};

/** Starts the local agent server for the cwd and stays alive until Ctrl+C. */
export async function serveCommand(opts: ServeOptions): Promise<void> {
  const { port, token, close } = await startServer({
    workspace: process.cwd(),
    port: opts.port,
  });

  console.log(`SeekForge server: http://127.0.0.1:${port}/?token=${token}`);
  console.log("Serving this workspace on 127.0.0.1 only. Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) process.exit(130);
      closing = true;
      console.error("\nshutting down…");
      void close().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
