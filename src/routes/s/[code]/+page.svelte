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
  // Для уже завершённых опросов SSR отдаёт агрегат из Postgres (Redis-ключи
  // почищены в processExpired). Иначе — стартуем с пустым облаком и ждём WS.
  // untrack — только начальное значение из data, дальше реактивность не нужна.
  let words = $state<Record<string, CloudWord[]>>(
    untrack(() => ({ ...(data.initialWords ?? {}) }))
  );
  let activeIdx = $state(0);
  let totalVotes = $derived(
    Object.values(words).reduce((s, w) => s + w.reduce((a, [, c]) => a + c, 0), 0)
  );

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopReconnect = false;
  // reload guard: сервер шлёт `closed` на момент атомарного перехода
  // active→expired, и если соединение мигнуло (или мы получили closed
  // дважды из-за реконнекта), мы успевали поставить два setTimeout(reload)
  // — первый делал перезагрузку, второй ловил уже новую страницу и снова
  // её перезагружал, обнуляя SSR-данные.
  let reloadScheduled = false;

  const activeQuestion = $derived(survey.questions[activeIdx] ?? survey.questions[0]);
  const activeWords = $derived(words[activeQuestion?.id] ?? []);

  /**
   * Аналитика облака для активного вопроса (правка №4):
   *   votes        — суммарное число ответов в этом вопросе;
   *   uniqueWords  — количество уникальных нормализованных слов;
   *   topWord      — самое популярное слово и его доля от всех голосов;
   *   diversity    — индекс разнообразия Симпсона (1 − Σpᵢ²): 0 — все
   *                  одинаково, 1 — максимально разнообразно;
   *   topShare     — концентрация: доля топ-3 слов от всех голосов.
   */
  const analytics = $derived.by(() => {
    const list = activeWords;
    const votes = list.reduce((s, [, c]) => s + c, 0);
    const uniqueWords = list.length;
    if (votes === 0 || uniqueWords === 0) {
      return {
        votes: 0,
        uniqueWords: 0,
        topWord: null as null | { word: string; count: number; share: number },
        diversity: 0,
        topShare: 0
      };
    }
    const sorted = [...list].sort((a, b) => b[1] - a[1]);
    const [topWord, topCount] = sorted[0];
    const sumSquares = list.reduce((s, [, c]) => s + (c / votes) ** 2, 0);
    const diversity = 1 - sumSquares;
    const top3 = sorted.slice(0, 3).reduce((s, [, c]) => s + c, 0);
    return {
      votes,
      uniqueWords,
      topWord: { word: topWord, count: topCount, share: topCount / votes },
      diversity,
      topShare: top3 / votes
    };
  });

  function connect() {
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
        baseSize: 20,
        maxWords: survey.maxWords,
        allowVertical: survey.allowVertical
      },
      token
    );
    return () => {
      token.cancelled = true;
    };
  });

  function downloadPng() {
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloud-${survey.code}-q${activeIdx + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function csvUrl(): string {
    return `/api/surveys/${survey.code}/export.csv?t=${encodeURIComponent(creatorToken)}`;
  }

  let confirmFinish = $state(false);
  let finishing = $state(false);
  let finishError = $state<string | null>(null);
  let retrying = $state(false);
  let retryError = $state<string | null>(null);

  async function retrySend() {
    retrying = true;
    retryError = null;
    try {
      const r = await fetch(
        `/api/surveys/${survey.code}/retry?t=${encodeURIComponent(creatorToken)}`,
        { method: 'POST' }
      );
      const data = await r.json();
      if (!r.ok) {
        retryError = data.error?.message ?? `Ошибка ${r.status}`;
        return;
      }
      window.location.reload();
    } catch (e) {
      retryError = (e as Error).message;
    } finally {
      retrying = false;
    }
  }

  async function finishSurvey() {
    finishing = true;
    finishError = null;
    try {
      const r = await fetch(
        `/api/surveys/${survey.code}/finish?t=${encodeURIComponent(creatorToken)}`,
        { method: 'POST' }
      );
      const data = await r.json();
      if (!r.ok) {
        finishError = data.error?.message ?? `Ошибка ${r.status}`;
        return;
      }
      window.location.reload();
    } catch (e) {
      finishError = (e as Error).message;
    } finally {
      finishing = false;
      confirmFinish = false;
    }
  }

  function fmtDate(d: string | Date): string {
    return new Date(d).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
  }

  function statusBadge(s: string): { text: string; cls: string } {
    switch (s) {
      case 'active':
        return { text: 'Активен', cls: 'badge badge-active' };
      case 'sent':
        return { text: 'Завершён', cls: 'badge badge-success' };
      case 'failed':
        return { text: 'Ошибка отправки', cls: 'badge badge-danger' };
      case 'expired':
        return { text: 'Обработка', cls: 'badge badge-muted' };
      default:
        return { text: s, cls: 'badge badge-muted' };
    }
  }

  const status = $derived(statusBadge(survey.status));
</script>

<svelte:head><title>Дашборд · {survey.title ?? survey.code}</title></svelte:head>

<header class="title-row">
  <div class="title-info">
    <div class="title-line">
      <h1>{survey.title ?? 'Опрос'}</h1>
      <span class={status.cls}>{status.text}</span>
    </div>
    <p class="muted">
      {isActive ? 'Истекает' : 'Завершён'}
      {fmtDate(survey.expiresAt)} · {totalVotes}
      {totalVotes === 1 ? 'голос' : totalVotes >= 2 && totalVotes <= 4 ? 'голоса' : 'голосов'}
    </p>
  </div>
  <div class="title-actions">
    <a class="btn btn-primary btn-sm" href={`/p/${survey.code}`}>Режим презентации</a>
    {#if isActive}
      {#if !confirmFinish}
        <button class="btn btn-danger btn-sm" onclick={() => (confirmFinish = true)}>
          Завершить
        </button>
      {/if}
    {/if}
  </div>
</header>

{#if confirmFinish}
  <div class="alert alert-warn" role="alertdialog" aria-label="Подтверждение завершения опроса">
    <div class="alert-text">
      <strong>Завершить опрос?</strong>
      Голосование закроется, агрегат отправится на email. Отменить нельзя.
    </div>
    <div class="alert-actions">
      <button class="btn btn-danger btn-sm" onclick={finishSurvey} disabled={finishing}>
        {finishing ? 'Завершаем…' : 'Да, завершить'}
      </button>
      <button class="btn btn-ghost btn-sm" onclick={() => (confirmFinish = false)}>Отмена</button>
    </div>
  </div>
{/if}

{#if finishError}
  <div class="alert alert-error" role="alert">{finishError}</div>
{/if}
{#if retryError}
  <div class="alert alert-error" role="alert">{retryError}</div>
{/if}

{#if survey.status === 'sent'}
  <div class="alert alert-success" role="status">
    Опрос завершён. Письмо с результатами отправлено на <b>{survey.creatorEmail}</b>.
  </div>
{:else if survey.status === 'failed'}
  <div class="alert alert-warn" role="status">
    <div class="alert-text">
      Опрос завершён, но <b>письмо не дошло</b>. Можно скачать CSV ниже или повторить отправку.
    </div>
    <div class="alert-actions">
      <button class="btn btn-primary btn-sm" onclick={retrySend} disabled={retrying}>
        {retrying ? 'Отправляем…' : 'Повторить отправку'}
      </button>
    </div>
  </div>
{:else if survey.status === 'expired'}
  <div class="alert alert-warn" role="status">
    <div class="alert-text">
      Голосование закрыто, идёт обработка результатов и отправка email. Если состояние не меняется
      больше минуты — нажмите ниже.
    </div>
    <div class="alert-actions">
      <button class="btn btn-ghost btn-sm" onclick={() => location.reload()}>Обновить</button>
      <button class="btn btn-primary btn-sm" onclick={retrySend} disabled={retrying}>
        {retrying ? 'Отправляем…' : 'Принудительно отправить'}
      </button>
    </div>
  </div>
{/if}

{#if isActive}
  <section class="card share">
    <div class="share-info">
      <div class="share-block">
        <h2 class="share-h">Код опроса</h2>
        <span
          class="big-code"
          role="button"
          tabindex="0"
          use:copyOnClick={{ kind: 'text', text: survey.code }}
        >
          {survey.code}
        </span>
      </div>
      <div class="share-block">
        <h2 class="share-h">Ссылка на опрос</h2>
        <span
          class="link-text"
          role="button"
          tabindex="0"
          title={respondentUrl}
          use:copyOnClick={{ kind: 'text', text: respondentUrl }}
        >
          {respondentUrl}
        </span>
      </div>
    </div>
    <img
      class="qr"
      src={qrPngBase64Data}
      alt="QR код опроса"
      title={respondentUrl}
      use:copyOnClick={{
        kind: 'image',
        image: qrPngBase64Data,
        fallbackText: respondentUrl
      }}
    />
  </section>
{/if}

<section class="card cloud-card">
  <div class="cloud-head">
    <h2>Облако</h2>
    <div class="cloud-actions">
      <a class="btn btn-ghost btn-sm" href={csvUrl()}>Скачать CSV</a>
      <button
        class="btn btn-ghost btn-sm"
        onclick={downloadPng}
        disabled={activeWords.length === 0}
      >
        Скачать PNG
      </button>
    </div>
  </div>

  {#if survey.questions.length > 1}
    <div class="tabs">
      {#each survey.questions as q, i (q.id)}
        <button
          type="button"
          class="tab"
          class:active={i === activeIdx}
          onclick={() => (activeIdx = i)}
        >
          {i + 1}. {q.text.length > 30 ? q.text.slice(0, 30) + '…' : q.text}
        </button>
      {/each}
    </div>
  {/if}

  <div class="active-question">{activeQuestion?.text}</div>

  <div class="canvas-wrap">
    {#if activeWords.length === 0}
      <div class="empty">
        {isActive
          ? 'Пока нет ответов. Поделитесь ссылкой или QR-кодом.'
          : 'Голосов в этом опросе не было.'}
      </div>
    {/if}
    <canvas bind:this={canvas} width="1200" height="700"></canvas>
  </div>

  <!-- Правка №4: аналитика облака. Считаем по активному вопросу:
       объём, уникальность, топ-слово и индекс разнообразия Симпсона. -->
  {#if activeWords.length > 0}
    <div class="analytics" aria-label="Аналитика облака">
      <div class="metric">
        <div class="metric-label">Голосов</div>
        <div class="metric-value">{analytics.votes}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Уникальных слов</div>
        <div class="metric-value">{analytics.uniqueWords}</div>
      </div>
      {#if analytics.topWord}
        <div class="metric">
          <div class="metric-label">Топ-слово</div>
          <div class="metric-value metric-value-text" title={analytics.topWord.word}>
            {analytics.topWord.word}
          </div>
          <div class="metric-sub">
            {analytics.topWord.count} · {(analytics.topWord.share * 100).toFixed(0)}%
          </div>
        </div>
      {/if}
      <div class="metric">
        <div class="metric-label">Доля топ-3</div>
        <div class="metric-value">{(analytics.topShare * 100).toFixed(0)}%</div>
        <div class="metric-sub">концентрация</div>
      </div>
      <div class="metric">
        <div class="metric-label">Разнообразие</div>
        <div class="metric-value">{analytics.diversity.toFixed(2)}</div>
        <div class="metric-sub">индекс Симпсона</div>
      </div>
    </div>
  {/if}
</section>

<style>
  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  .title-info {
    min-width: 0;
    flex: 1;
  }
  .title-line {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  h1 {
    margin: 0 0 var(--space-1);
  }
  .muted {
    color: var(--c-muted);
    margin: 0;
    font-size: 0.9375rem;
  }
  .title-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* ─── Алерты ──────────────────── */
  .alert {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius);
    border: 1px solid;
    margin-bottom: var(--space-4);
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  .alert-text {
    flex: 1;
    min-width: 200px;
  }
  .alert-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .alert-error {
    background: var(--c-danger-bg);
    color: var(--c-danger);
    border-color: var(--c-danger-border);
  }
  .alert-success {
    background: var(--c-success-bg);
    color: var(--c-success);
    border-color: var(--c-success-border);
  }
  .alert-warn {
    background: var(--c-warn-bg);
    color: var(--c-text);
    border-color: var(--c-warn-border);
  }

  /* ─── Share-карта ──────────────────── */
  .share {
    display: flex;
    gap: var(--space-6);
    align-items: flex-start;
    flex-wrap: wrap;
    padding: var(--space-6);
  }
  .share-info {
    flex: 1;
    min-width: 240px;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
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
  /* .big-code/.link-text/.qr — кликабельны через action copyOnClick;
     visual hint и клик-цель совпадают, поэтому box-style + cursor:pointer
     ставим прямо на сам элемент. Кнопок «Копировать» больше нет —
     hover-tooltip действует как индикатор копируемости. */
  .big-code,
  .link-text {
    user-select: none;
    transition: background-color 120ms;
    border-radius: var(--radius);
    align-self: flex-start;
    max-width: 100%;
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
    letter-spacing: 0.15em;
    font-family: var(--font-mono);
    line-height: 1;
    padding: var(--space-2);
    word-break: break-all;
  }
  .link-text {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    color: var(--c-text);
    background: var(--c-bg);
    border: 1px solid var(--c-border);
    padding: 8px 10px;
    word-break: break-all;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qr {
    width: 280px;
    height: 280px;
    image-rendering: pixelated;
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    background: #fff;
    flex-shrink: 0;
    transition: transform 120ms;
  }
  .qr:hover {
    transform: scale(1.02);
  }

  /* ─── Облако ──────────────────── */
  .cloud-card {
    margin-top: var(--space-4);
  }
  .cloud-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .cloud-head h2 {
    margin: 0;
  }
  .cloud-actions {
    display: flex;
    gap: var(--space-2);
  }
  .tabs {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .tab {
    background: transparent;
    color: var(--c-muted);
    border: 1px solid var(--c-border);
    padding: 6px 12px;
    border-radius: var(--radius);
    font-family: inherit;
    font-size: 0.875rem;
    cursor: pointer;
    transition:
      background-color 120ms,
      color 120ms;
  }
  .tab:hover:not(.active) {
    background: var(--c-surface);
    color: var(--c-text);
  }
  .tab.active {
    background: var(--c-navy);
    color: white;
    border-color: var(--c-navy);
  }
  .active-question {
    font-weight: 500;
    margin-bottom: var(--space-3);
    color: var(--c-text);
  }
  .canvas-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 12 / 7;
    background: #fff;
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .analytics {
    margin-top: var(--space-4);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-3);
  }
  .metric {
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .metric-label {
    font-size: 0.75rem;
    color: var(--c-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .metric-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--c-navy);
    line-height: 1.1;
  }
  .metric-value-text {
    font-size: 1.125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metric-sub {
    font-size: 0.75rem;
    color: var(--c-muted);
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
  }

  @media (max-width: 720px) {
    .title-row {
      flex-direction: column;
      align-items: stretch;
    }
    .share {
      flex-direction: column-reverse;
      align-items: center;
    }
    .share-info {
      width: 100%;
    }
    .qr {
      width: 240px;
      height: 240px;
    }
    .big-code {
      font-size: 1.875rem;
    }
    .cloud-head {
      flex-direction: column;
      align-items: stretch;
    }
    .cloud-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    .canvas-wrap {
      aspect-ratio: 4 / 5;
    }
    .tabs {
      overflow-x: auto;
      flex-wrap: nowrap;
      scrollbar-width: thin;
    }
    .tab {
      white-space: nowrap;
      flex-shrink: 0;
    }
  }
</style>
