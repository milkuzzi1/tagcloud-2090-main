<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();

  /**
   * Обновление статусов:
   *  - WS `/ws/u`: per-user push-канал. Сервер пушит `survey-status`,
   *    как только статус опроса фактически меняется (cron, /finish,
   *    /retry). Это даёт «мгновенное» обновление UI — раньше
   *    пользователь видел «Истёк» до 90с, пока не поллингу не
   *    приходила свежая выборка.
   *  - Фоновый poll (180с): запасной канал на случай, если WS
   *    разорвался (мобильный, прокси, и т.п.). Реже, чем раньше —
   *    основная нагрузка снята с polling'а на push.
   */
  const POLL_MS = 180_000;
  const WS_PATH = '/ws/u';
  const WS_RECONNECT_MS = 3_000;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let ws: WebSocket | null = null;
  let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let pageDestroyed = false;

  function hasNonTerminal(): boolean {
    return data.surveys.some((s) => s.status === 'active' || s.status === 'expired');
  }

  function openWs() {
    if (typeof window === 'undefined') return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    } catch {
      ws = null;
      scheduleReconnect();
      return;
    }
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === 'survey-status') {
          // Без диффа в локальной модели — invalidateAll() вытащит
          // полный список (там же questionsCount/responsesCount,
          // которые тоже могли сменится).
          void invalidateAll();
        }
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
      if (!pageDestroyed) scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    });
  }

  function scheduleReconnect() {
    if (pageDestroyed) return;
    if (wsRetryTimer) return;
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      openWs();
    }, WS_RECONNECT_MS);
  }

  onMount(() => {
    openWs();
    pollHandle = setInterval(() => {
      if (!hasNonTerminal()) return;
      void invalidateAll();
    }, POLL_MS);
  });

  onDestroy(() => {
    pageDestroyed = true;
    if (pollHandle) clearInterval(pollHandle);
    if (wsRetryTimer) clearTimeout(wsRetryTimer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  });

  function fmtDate(d: Date | string): string {
    return new Date(d).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  }

  function plural(n: number, [one, few, many]: [string, string, string]): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function statusBadge(s: string): { text: string; cls: string; title?: string } {
    switch (s) {
      case 'active':
        return { text: 'Активен', cls: 'badge badge-active' };
      case 'sent':
        return { text: 'Завершён', cls: 'badge badge-success' };
      case 'failed':
        return {
          text: 'Ошибка отправки',
          cls: 'badge badge-danger',
          title: 'Email не дошёл — нажмите «Повторить отправку»'
        };
      case 'expired':
        return {
          text: 'Истёк',
          cls: 'badge badge-muted',
          title: 'Срок голосования истёк, обработка результатов'
        };
      default:
        return { text: s, cls: 'badge badge-muted' };
    }
  }

  let copying = $state<string | null>(null);
  async function copyLink(code: string, e: Event) {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(`${location.origin}/r/${code}`);
      copying = code;
      setTimeout(() => {
        if (copying === code) copying = null;
      }, 1500);
    } catch {}
  }

  let finishing = $state<string | null>(null);
  let retrying = $state<string | null>(null);

  let confirmCode = $state<string | null>(null);

  async function finishSurvey(code: string) {
    finishing = code;
    confirmCode = null;
    try {
      const r = await fetch(`/api/surveys/${code}/finish`, { method: 'POST' });
      if (r.ok) {
        location.reload();
      } else {
        const body = await r.json().catch(() => ({}));
        alert(body?.error?.message ?? `Ошибка ${r.status}`);
      }
    } finally {
      finishing = null;
    }
  }

  async function retrySend(code: string) {
    retrying = code;
    try {
      const r = await fetch(`/api/surveys/${code}/retry`, { method: 'POST' });
      if (r.ok) {
        location.reload();
      } else {
        const body = await r.json().catch(() => ({}));
        alert(body?.error?.message ?? `Ошибка ${r.status}`);
      }
    } finally {
      retrying = null;
    }
  }
</script>

<svelte:head><title>Мои опросы — Облако тегов 2090</title></svelte:head>

<div class="head">
  <h1>Мои опросы</h1>
  <a class="btn btn-primary" href="/new">Создать опрос</a>
</div>

{#if data.surveys.length === 0}
  <div class="empty">
    <p>У вас пока нет опросов.</p>
  </div>
{:else}
  <ul class="list">
    {#each data.surveys as s (s.code)}
      {@const status = statusBadge(s.status)}
      <li class="card">
        <div class="card-head">
          <a class="title" href={`/s/${s.code}`}>
            {s.title ?? 'Опрос'}
          </a>
          <span class={status.cls} title={status.title ?? ''}>{status.text}</span>
        </div>
        <div class="meta">
          <span>
            {s.questionsCount}
            {plural(s.questionsCount, ['вопрос', 'вопроса', 'вопросов'])}
          </span>
          <span>
            {s.responsesCount}
            {plural(s.responsesCount, ['ответ', 'ответа', 'ответов'])}
          </span>
          <span>
            {s.status === 'active' ? 'истекает' : 'завершён'}
            {fmtDate(s.expiresAt)}
          </span>
        </div>
        <div class="actions">
          {#if s.status === 'active'}
            <button class="btn btn-primary btn-sm" onclick={(e) => copyLink(s.code, e)}>
              {copying === s.code ? 'Скопировано' : 'Копировать ссылку'}
            </button>
            {#if confirmCode === s.code}
              <span class="confirm-inline">
                Завершить опрос?
                <button
                  class="btn btn-danger btn-sm"
                  onclick={() => finishSurvey(s.code)}
                  disabled={finishing === s.code}
                >
                  {finishing === s.code ? 'Завершаем…' : 'Да, завершить'}
                </button>
                <button class="btn btn-ghost btn-sm" onclick={() => (confirmCode = null)}>
                  Отмена
                </button>
              </span>
            {:else}
              <button class="btn btn-danger btn-sm" onclick={() => (confirmCode = s.code)}>
                Завершить
              </button>
            {/if}
          {:else if s.status === 'failed' || s.status === 'expired'}
            <button
              class="btn btn-primary btn-sm"
              onclick={() => retrySend(s.code)}
              disabled={retrying === s.code}
            >
              {retrying === s.code ? 'Отправляем…' : 'Повторить отправку'}
            </button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-6);
    gap: var(--space-3);
  }
  h1 {
    margin: 0;
  }
  .empty {
    text-align: center;
    padding: var(--space-12) 0;
    color: var(--c-muted);
  }
  .empty p {
    margin-bottom: var(--space-4);
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  .title {
    font-weight: 500;
    color: var(--c-navy);
    text-decoration: none;
    font-size: 1.0625rem;
  }
  .title:hover {
    text-decoration: underline;
  }

  .meta {
    color: var(--c-muted);
    font-size: 0.875rem;
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: var(--space-3);
  }
  .code {
    font-family: var(--font-mono);
    background: var(--c-bg);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--c-navy);
    font-weight: 600;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    align-items: center;
  }
  .confirm-inline {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--c-text);
    font-size: 0.875rem;
    background: var(--c-warn-bg);
    border: 1px solid var(--c-warn-border);
    padding: 4px 10px;
    border-radius: var(--radius);
  }

  @media (max-width: 640px) {
    .head {
      flex-direction: column;
      align-items: stretch;
    }
    .head .btn {
      width: 100%;
    }
    .card-head {
      flex-direction: column;
      align-items: flex-start;
    }
    .meta {
      gap: var(--space-2);
      font-size: 0.8125rem;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr;
    }
    .confirm-inline {
      grid-column: 1 / -1;
      justify-content: space-between;
    }
  }
</style>
