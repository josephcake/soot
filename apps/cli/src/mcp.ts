import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createSootMcpServer, type OrchestrationService } from '@soot/harness-adapters';
import { VERSION } from './version.js';

/** Serve soot's MCP tools on stdin/stdout until the client closes the connection. */
export async function serveMcpStdio(service: OrchestrationService): Promise<void> {
  const server = createSootMcpServer(service, { name: 'soot', version: VERSION });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => {
      resolve();
    };
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
