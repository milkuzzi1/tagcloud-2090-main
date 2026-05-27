import bcrypt from 'bcrypt';

const ROUNDS = 11;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Lazy-инициализированный фейковый bcrypt-хэш для timing-safe `login()` ветки
// «пользователь не существует». Считается один раз при первом обращении —
// 11 rounds = ~80мс, и держим в памяти процесса.
//
// Назначение: уравнять время отклика для существующего и несуществующего
// email. Без этого злоумышленник по разнице задержки 5мс vs 80мс может перебирать
// валидные адреса (классический enumeration-таймер).
let dummyHashPromise: Promise<string> | null = null;
const DUMMY_PASSWORD = 'devin-dummy-password-for-timing-equalization';

export async function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(DUMMY_PASSWORD, ROUNDS);
  }
  return dummyHashPromise;
}
