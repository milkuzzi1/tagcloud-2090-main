<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { PageProps } from './$types';
  import type { CloudWord } from '$lib/types/cloud';
  import { renderCloud } from '$lib/cloud-render';
  import type { ServerMsg } from '$lib/types/cloud';

  let { data }: PageProps = $props();
  const survey = $derived(data.survey);
  const creatorToken = $derived(data.creatorToken);

  let canvas = $state<HTMLCanvasElement | null>(null);
  // Initial-only чтение через untrack: SSR-снапшот фиксирован, дальше
  // обновляем words только из WS-сообщений.
  let words = $state<Record<string, CloudWord[]>>(untrack(() => ({ ...data.initialWords })));
  let activeIdx = $state(0);
  // Стартовое значение фиксируем через untrack: SSR-снапшот survey.status —
  // это начальное состояние, а дальше «закрытость» идёт из WS-сообщения
  // 'closed'. Без untrack Svelte 5 предупреждает о захвате реактивного $derived.
  let stopped = $state(untrack(() => survey.status !== 'active'));

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopReconnect = false;

  const activeQuestion = $derived(survey.questions[activeIdx] ?? survey.questions[0]);
  const activeWords = $derived(words[activeQuestion?.id] ?? []);
  const totalVotes = $derived(activeWords.reduce((s, [, c]) => s + c, 0));

  /**
   * Подключение к креатор-WS `/ws/<code>?t=<token>`. Сервер пушит
   * cloud:<questionId> snapshots каждые 2.5с при наличии изменений
   * (без поллинга и без нагрузки на Postgres).
   */
  function connect(): void {
    if (typeof window === 'undefined') return;
    if (stopReconnect || stopped) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(
      `${proto}://${window.location.host}/ws/${survey.code}?t=${encodeURIComponent(creatorToken)}`
    );
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.type === 'snapshot') {
          words = { ...words, [msg.questionId]: msg.words };
        } else if (msg.type === 'closed') {
          stopReconnect = true;
          stopped = true;
          ws?.close();
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (stopReconnect) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Экспоненциальная пауза не нужна — обычные WS-разрывы редки и
      // 3 секунды дают серверу спокойно перезапуститься.
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  onMount(() => {
    if (!stopped) connect();
  });

  onDestroy(() => {
    stopReconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws && ws.readyState === ws.OPEN) ws.close(1000, 'page unload');
  });

  // Подгоняем canvas под размер окна, чтобы облако занимало всё доступное
  // пространство в новой вкладке. Размер canvas — это logical render-size
  // для d3-cloud; пересчёт идёт через resize-наблюдатель + перерисовку.
  let viewportSize = $state({ width: 1600, height: 900 });
  onMount(() => {
    function updateSize() {
      viewportSize = {
        width: Math.max(640, window.innerWidth),
        height: Math.max(360, window.innerHeight)
      };
    }
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  });

  $effect(() => {
    if (!canvas) return;
    canvas.width = viewportSize.width;
    canvas.height = viewportSize.height;
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
</script>

<svelte:head>
  <title>Облако · {survey.title ?? 'Опрос'}</title>
</svelte:head>

<!--
  Чистый просмотр облака: страница не содержит шапки, футера или
  навигации — только canvas с облаком (правка №2). Глобальная шапка
  отключена в src/routes/+layout.svelte по route.id = '/c/[code]'.
  Многовопросный опрос переключается через минималистичный оверлей
  снизу страницы.
-->
<div class="cloud-screen">
  <canvas
    bind:this={canvas}
    width={viewportSize.width}
    height={viewportSize.height}
    aria-label="Облако ответов"
  ></canvas>

  {#if activeWords.length === 0}
    <div class="empty">
      {stopped ? 'Голосов в этом опросе не было.' : 'Пока нет ответов.'}
    </div>
  {/if}

  {#if survey.questions.length > 1}
    <nav class="tabs" aria-label="Переключение между вопросами">
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

  <div class="vote-count" aria-live="polite">
    {totalVotes}
  </div>
</div>

<style>
  .cloud-screen {
    position: relative;
    width: 100vw;
    height: 100vh;
    background: #ffffff;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100vw;
    height: 100vh;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c-muted);
    font-size: 1.125rem;
    pointer-events: none;
  }
  .tabs {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 6px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
  }
  .tab {
    border: 1px solid var(--c-border);
    background: var(--c-bg);
    color: var(--c-text);
    border-radius: var(--radius);
    padding: 4px 10px;
    font-size: 0.875rem;
    cursor: pointer;
  }
  .tab.active {
    background: var(--c-navy);
    color: white;
    border-color: var(--c-navy);
  }
  .vote-count {
    position: absolute;
    top: 16px;
    right: 16px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    padding: 4px 10px;
    color: var(--c-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }
</style>
