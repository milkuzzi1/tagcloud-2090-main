declare global {
namespace App {
  interface Error {
    message: string;
    // errorId, который мы возвращаем из handleError. Пользователь может
    // процитировать его в баг-репорте, мы найдём запись по requestId/errorId
    // в JSON-логах.
    errorId?: string;
  }
  interface Locals {
    user: {
      id: string;
      email: string;
      role: 'admin' | 'user';
    } | null;
    // Реальный IP клиента, выставленный в hooks.server.ts через
    // `getClientIpFromKitEvent`. Доверяет XFF только когда socket-peer входит
    // в TRUSTED_PROXY_CIDRS (дефолт — приватные диапазоны). См.
    // `$lib/server/net/client-ip.ts`.
    clientIp: string;
  }
  // interface PageData {}
  // interface PageState {}
  // interface Platform {}
}
}

export {};
