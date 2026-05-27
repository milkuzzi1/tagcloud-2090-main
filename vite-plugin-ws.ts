import type { Plugin, ViteDevServer } from 'vite';

let attached = false;

export function tagcloudWsPlugin(): Plugin {
  return {
    name: 'tagcloud-ws',
    configureServer(server: ViteDevServer) {
      if (attached || !server.httpServer) return;
      attached = true;

      server.httpServer.on('upgrade', async (req, socket, head) => {
        if (!req.url?.startsWith('/ws/')) return;
        try {
          const mod = await server.ssrLoadModule('/src/lib/server/realtime/ws-server.ts');
          await mod.handleUpgrade(req, socket, head);
        } catch (err) {
          console.error('[tagcloud-ws] upgrade failed:', err);
          socket.destroy();
        }
      });
    }
  };
}
