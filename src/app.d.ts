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
        organizationId: string;
        organizationName: string;
      } | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
