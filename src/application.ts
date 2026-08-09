import {
  createServer,
  type Server,
} from "node:http";
import {
  createProcessingRequestListener,
  type ProcessingHttpOptions,
} from "./http-adapter.js";
import type { ProcessExecutor } from "./process-runtime.js";

export type ProcessingApplication = {
  listen: (options?: {
    host?: string;
    port?: number;
  }) => Promise<{ url: string }>;
  close: () => Promise<void>;
};

export type ProcessingApplicationOptions = {
  executor: ProcessExecutor;
  http?: ProcessingHttpOptions;
  closeResources?: () => Promise<void>;
};

export function createProcessingApplication(
  options: ProcessingApplicationOptions,
): ProcessingApplication {
  const server = createServer(
    createProcessingRequestListener(options.executor, options.http),
  );
  let resourcesClosed = false;

  return {
    listen: async (listenOptions) => ({
      url: await listen(server, listenOptions),
    }),
    close: async () => {
      try {
        await close(server);
      } finally {
        if (!resourcesClosed) {
          resourcesClosed = true;
          await options.closeResources?.();
        }
      }
    },
  };
}

async function listen(
  server: Server,
  options: { host?: string; port?: number } = {},
): Promise<string> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the server to listen on an IP address");
  }
  return `http://${host}:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
