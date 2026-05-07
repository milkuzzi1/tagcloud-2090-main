<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { CloudWord, ServerMsg } from '$lib/types/cloud';
  import { renderCloud } from '$lib/cloud-render';
  import { copyOnClick } from '$lib/actions/copy-on-click';

  let { data }: PageProps = $props();
  const survey = $derived(data.survey);
  const respondentUrl = $derived(data.respondentUrl);
  const qrPngBase64Data = $derived(data.qrPngBase64Data);
  const creatorToken = $derived(data.creatorToken);
  const isActive = $derived(survey.status === 'active');

  let canvas = $state<HTMLCanvasElement | null>(null);
  // Initial-only чтение через untrack: SSR-снапшот фиксирован, дальше
  // обновляем words только из WS-сообщений.
  let words = $state<Record<string, CloudWord[]>>(
    untrack(() => ({ ...(data.initialWords ?? {}) }))
  );
  let activeIdx = $state(0);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopReconnect = false;
  // reload guard: см. комментарий в /s/[code]/+page.svelte. На презентации
  // reload менее болезнен (нет form state), но логика та же — закрытый
  // опрос триггерит одну перезагрузку.
  let reloadScheduled = false;

  const activeQuestion = $derived(survey.questions[activeIdx] ?? survey.questions[0]);
  const activeWords = $derived(words[activeQuestion?.id] ?? []);
  const totalVotes = $derived(activeWords.reduce((s, [, c]) => s + c, 0));

  function votePlural(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'голос';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'голоса';
    return 'голосов';
  }

  function connect(): void {
    if (typeof window === 'undefined') return;
    if (stopReconnect) return;
    if (!isActive) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/${survey.code}?t=${encodeURIComponent(creatorToken)}`;
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.type === 'snapshot') {
          words = { ...words, [msg.questionId]: msg.words };
        } else if (msg.type === 'closed') {
          stopReconnect = true;
          ws?.close();
          if (!reloadScheduled) {
            reloadScheduled = true;
            setTimeout(() => location.reload(), 250);
          }
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (stopReconnect) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => {
      ws?.close();
    };
  }

  onMount(() => {
    if (isActive) connect();
  });

  onDestroy(() => {
    stopReconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws && ws.readyState === ws.OPEN) ws.close(1000, 'page unload');
  });

  $effect(() => {
    if (!canvas) return;
    const list = activeWords;
    if (list.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      ctx!.fillStyle = '#FFFFFF';
      ctx!.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const token = { cancelled: false };
    void renderCloud(
      canvas,
      list,
      survey.colorScheme,
      survey.customPalette,
      {
        baseSize: 24,
        maxWords: survey.maxWords,
        allowVertical: survey.allowVertical
      },
      token
    );
    return () => {
      token.cancelled = true;
    };
  });

  // Полноэкранный режим: для презентации в классе удобно убрать вкладку
  // и адресную строку. Используем стандартный Fullscreen API; при отказе
  // (Safari/iOS, no permission) просто игнорируем.
  let isFullscreen = $state(false);
  function toggleFullscreen() {
    if (typeof document === 'undefined') return;
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }
  function onFullscreenChange() {
    isFullscreen = typeof document !== 'undefined' && !!document.fullscreenElement;
  }
  onMount(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  });

  // Стрелочки для переключения между вопросами с клавиатуры — удобно,
  // когда руки на пульте/кликере. Работает только если вопросов > 1.
  function onKeydown(e: KeyboardEvent) {
    if (survey.questions.length <= 1) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      activeIdx = (activeIdx + 1) % survey.questions.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      activeIdx = (activeIdx - 1 + survey.questions.length) % survey.questions.length;
    }
  }
</script>

<svelte:head>
  <title>Презентация · {survey.title ?? survey.code}</title>
</svelte:head>

<svelte:window onkeydown={onKeydown} />

<!--
  Режим презентации: облако — full-bleed на левой колонке, сайдбар
  с реквизитами опроса прижат к правому краю окна (border-left, без
  внешнего padding). Заголовок опроса, подсказка про стрелки и кнопки
  копирования убраны: вкладки/текст вопроса/счётчик голосов выведены
  оверлеем поверх облака; для копирования кода/ссылки/QR — hover-tooltip
  («Скопировать» → «Скопировано»), action в $lib/actions/copy-on-click.

  :global(main.container) сбрасывается только пока этот компонент
  смонтирован — на остальных страницах сохраняется обычная ширина.
-->
<div class="presentation">
  <section class="cloud-area" aria-label="Облако ответов">
    <canvas bind:this={canvas} width="1600" height="900"></canvas>

    {#if activeWords.length === 0}
      <div class="empty">
        {isActive
          ? 'Пока нет ответов. Покажите QR-код или код опроса.'
          : 'Голосов в этом опросе не было.'}
      </div>
    {/if}

    {#if survey.questions.length > 1}
      <nav class="overlay tabs" aria-label="Переключение между вопросами">
        {#each survey.questions as q, i (q.id)}
          <button
            type="button"
            class="tab"
            class:active={i === activeIdx}
            onclick={() => (activeIdx = i)}
            title={q.text}
          >
            {i + 1}
          </button>
        {/each}
      </nav>
    {/if}

    <div class="overlay question-text">{activeQuestion?.text}</div>

    <div class="overlay vote-count">
      {totalVotes}
      {votePlural(totalVotes)}
    </div>

    <div class="overlay actions">
      <a class="btn btn-ghost btn-sm" href={`/s/${survey.code}`}>В дашборд</a>
      <button type="button" class="btn btn-ghost btn-sm" onclick={toggleFullscreen}>
        {isFullscreen ? 'Свернуть' : 'Полный экран'}
      </button>
    </div>

    {#if !isActive}
      <div class="overlay status-badge">
        <span class="badge badge-muted">Опрос завершён</span>
      </div>
    {/if}
  </section>

  <aside class="share-side" aria-label="Реквизиты опроса">
    <div class="share-block">
      <h2 class="share-h">Код опроса</h2>
      <div
        class="big-code"
        role="button"
        tabindex="0"
        use:copyOnClick={{ kind: 'text', text: survey.code }}
      >
        {survey.code}
      </div>
    </div>

    <div class="share-block">
      <h2 class="share-h">Ссылка</h2>
      <div
        class="link-text"
        role="button"
        tabindex="0"
        title={respondentUrl}
        use:copyOnClick={{ kind: 'text', text: respondentUrl }}
      >
        {respondentUrl}
      </div>
    </div>

    <div class="share-block qr-block">
      <h2 class="share-h">QR-код</h2>
      <img
        class="qr"
        src={qrPngBase64Data}
        alt="QR код опроса"
        title={respondentUrl}
        use:copyOnClick={{ kind: 'text', text: respondentUrl }}
      />
    </div>
  </aside>
</div>

<style>
  /* Полное полотно: убираем root-layout container и его padding,
     чтобы сайдбар лёг ровно к правому краю viewport'а, а облако
     заняло всю оставшуюся ширину. !important нужен потому, что
     селектор .container в /+layout.svelte получает Svelte-хеш
     (.container.svelte-XXXX, специфичность 0,2,0) и без !important
     перебивает наш :global(main.container) (специфичность 0,1,1). */
  :global(main.container) {
    max-width: none !important;
    padding: 0 !important;
    min-height: calc(100vh - 130px);
  }

  .presentation {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    align-items: stretch;
    min-height: calc(100vh - 130px);
  }

  /* ─── Левая колонка: облако full-bleed ─────────────── */
  .cloud-area {
    position: relative;
    background: #fff;
    overflow: hidden;
    min-width: 0;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c-muted);
    z-index: 1;
    pointer-events: none;
    text-align: center;
    padding: var(--space-4);
    font-size: 1.0625rem;
  }

  /* Overlay-элементы: position:absolute поверх canvas, z-index>0,
     чтобы перекрывать .empty (z-index:1 → у overlay 2). */
  .overlay {
    position: absolute;
    z-index: 2;
  }
  .tabs {
    top: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: var(--space-1);
    background: rgba(255, 255, 255, 0.88);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    padding: 4px;
    border-radius: var(--radius);
    border: 1px solid var(--c-border);
    box-shadow: var(--shadow-sm);
  }
  .tab {
    background: transparent;
    color: var(--c-muted);
    border: 0;
    padding: 6px 14px;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color 120ms,
      color 120ms;
    min-width: 36px;
  }
  .tab:hover:not(.active) {
    background: var(--c-surface);
    color: var(--c-text);
  }
  .tab.active {
    background: var(--c-navy);
    color: white;
  }
  .question-text {
    top: var(--space-4);
    left: var(--space-4);
    max-width: min(60%, 720px);
    font-weight: 500;
    color: var(--c-text);
    font-size: 1.0625rem;
    background: rgba(255, 255, 255, 0.88);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    padding: 8px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--c-border);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vote-count {
    bottom: var(--space-4);
    left: var(--space-4);
    color: var(--c-text);
    font-size: 1rem;
    font-weight: 600;
    background: rgba(255, 255, 255, 0.88);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    padding: 6px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--c-border);
    box-shadow: var(--shadow-sm);
  }
  .actions {
    top: var(--space-4);
    right: var(--space-4);
    display: flex;
    gap: var(--space-2);
  }
  .status-badge {
    bottom: var(--space-4);
    right: var(--space-4);
  }

  /* ─── Правая колонка: вертикальный sticky-блок ────── */
  .share-side {
    background: var(--c-surface);
    border-left: 1px solid var(--c-border);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    align-self: stretch;
  }
  .share-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .share-h {
    font-size: 0.75rem;
    color: var(--c-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin: 0;
  }
  .big-code,
  .link-text {
    user-select: none;
    transition: background-color 120ms;
    border-radius: var(--radius);
  }
  .big-code:hover,
  .link-text:hover {
    background: rgba(14, 42, 92, 0.06);
  }
  .big-code:focus-visible,
  .link-text:focus-visible {
    outline: 2px solid var(--c-navy);
    outline-offset: 2px;
  }
  .big-code {
    font-size: 2.25rem;
    font-weight: 700;
    color: var(--c-navy);
    letter-spacing: 0.12em;
    font-family: var(--font-mono);
    line-height: 1;
    word-break: break-all;
    padding: var(--space-2);
  }
  .link-text {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    color: var(--c-text);
    word-break: break-all;
    background: var(--c-bg);
    padding: 8px 10px;
    border: 1px solid var(--c-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qr-block {
    align-items: center;
  }
  .qr {
    width: 100%;
    max-width: 280px;
    aspect-ratio: 1 / 1;
    image-rendering: pixelated;
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    background: #fff;
    transition: transform 120ms;
  }
  .qr:hover {
    transform: scale(1.02);
  }

  /* ─── Адаптив ─────────────────────────────────────── */
  @media (max-width: 960px) {
    .presentation {
      grid-template-columns: 1fr;
    }
    .share-side {
      border-left: 0;
      border-top: 1px solid var(--c-border);
      order: 2;
    }
    .cloud-area {
      order: 1;
      min-height: 60vh;
    }
    .question-text {
      max-width: calc(100% - var(--space-4) * 2);
      font-size: 0.9375rem;
    }
    .actions {
      top: var(--space-2);
      right: var(--space-2);
    }
    .qr {
      max-width: 220px;
    }
  }
</style>
