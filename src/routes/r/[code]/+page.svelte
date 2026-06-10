<script lang="ts">
  import { untrack, onDestroy } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  type ScreenState = 'form' | 'sending' | 'sent' | 'already' | 'closed';
  // Initial-only чтения через untrack: страница SSR-рендерится с фиксированным
  // data из server load, реактивность нам тут не нужна и Svelte 5 справедливо
  // предупредит без untrack.
  const survey = untrack(() => data.survey);
  const initialExpired = untrack(() => data.expired);
  const initialAlreadyVoted = untrack(() => data.alreadyVoted);
  let screen = $state<ScreenState>(
    initialExpired ? 'closed' : initialAlreadyVoted ? 'already' : 'form'
  );

  // Шаговый wizard: показываем по одному вопросу. После последнего —
  // submit накопленных ответов. Это требование правки №5: на странице
  // ответов один вопрос, одна-две кнопки в зависимости от типа.
  let currentIdx = $state(0);

  // ответы: questionId -> string[]. На multi-вопросе массив наполняется
  // по мере нажатия «Ответить»; на single — всегда длиной 1.
  let answers = $state<Record<string, string[]>>(
    Object.fromEntries(survey.questions.map((q) => [q.id, []]))
  );

  // Текущее значение единственного поля ввода. Очищается после каждого
  // нажатия «Ответить» в multi-режиме.
  let inputValue = $state('');

  let errorMessage = $state<string | null>(null);
  let errorQuestionId = $state<string | null>(null);

  function stripWhitespace(s: string): string {
    return s.replace(/\s+/g, '');
  }

  // Single-word answers only. Instead of silently swallowing the spacebar
  // (which feels broken to the user), we prevent the space but surface a
  // short, screen-reader-announced hint explaining why.
  let spaceHint = $state(false);
  let spaceHintTimer: ReturnType<typeof setTimeout> | undefined;
  function blockSpace(e: KeyboardEvent) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      spaceHint = true;
      clearTimeout(spaceHintTimer);
      spaceHintTimer = setTimeout(() => (spaceHint = false), 2500);
    }
  }

  // Чистим висящий таймер при размонтировании: иначе setTimeout мог бы
  // сработать после ухода со страницы (обновление state после unmount).
  onDestroy(() => clearTimeout(spaceHintTimer));

  function removeWord(qid: string, idx: number) {
    answers[qid].splice(idx, 1);
  }

  const currentQuestion = $derived(survey.questions[currentIdx]);
  const isLast = $derived(currentIdx === survey.questions.length - 1);
  const currentAnswers = $derived(answers[currentQuestion?.id ?? ''] ?? []);
  const currentMax = $derived(
    currentQuestion?.answerType === 'multi' ? currentQuestion.maxAnswers : 1
  );
  const reachedLimit = $derived(currentAnswers.length >= currentMax);

  /**
   * Кнопка «Ответить».
   *
   * - single: фиксирует ответ и сразу переходит к следующему вопросу
   *   (или submit на последнем) — это требование правки №5: «Одно слово»
   *   = одно поле ввода + одна кнопка «Ответить».
   *
   * - multi: добавляет слово в локальный буфер ответов на этот вопрос,
   *   очищает поле, остаётся на том же вопросе. Когда буфер достигает
   *   maxAnswers — авто-переход (логично: больше ответов всё равно
   *   нельзя). Кнопки добавления/удаления полей нет, всё через одно
   *   общее поле — баг №5 («кнопок добавления полей быть не должно»).
   */
  async function answerCurrent(): Promise<void> {
    errorMessage = null;
    errorQuestionId = null;
    const q = currentQuestion;
    if (!q) return;
    const word = stripWhitespace(inputValue).trim();
    if (!word) {
      errorQuestionId = q.id;
      errorMessage = 'Введите слово';
      return;
    }
    // Дубликаты: один и тот же ответ от одного пользователя — это шум.
    // Лучше предупредить, чем тихо пропустить или удвоить голос.
    if (answers[q.id].includes(word)) {
      errorQuestionId = q.id;
      errorMessage = 'Это слово уже добавлено';
      return;
    }
    if (answers[q.id].length >= currentMax) {
      errorQuestionId = q.id;
      errorMessage = 'Достигнут лимит ответов на этот вопрос';
      return;
    }
    answers[q.id].push(word);
    inputValue = '';

    if (q.answerType === 'single') {
      if (isLast) await submit();
      else currentIdx += 1;
      return;
    }
    // multi: остаёмся на вопросе пока есть свободные слоты;
    // достигнут лимит — авто-переход.
    if (answers[q.id].length >= currentMax) {
      if (isLast) await submit();
      else currentIdx += 1;
    }
  }

  /**
   * «Следующий вопрос» в multi: уходит дальше, не требуя дополнительного
   * ответа в текущем вопросе. Уже добавленные слова сохраняются в
   * answers[qid]. На последнем вопросе кнопка не показывается;
   * финальный «Завершить» инициирует submit.
   */
  async function nextOrSkip(): Promise<void> {
    errorMessage = null;
    errorQuestionId = null;
    inputValue = '';
    if (isLast) {
      await submit();
      return;
    }
    currentIdx += 1;
  }

  async function submit(): Promise<void> {
    const payload = {
      answers: survey.questions
        .map((q) => ({
          questionId: q.id,
          words: (answers[q.id] ?? []).map((w) => w.trim()).filter((w) => w.length > 0)
        }))
        .filter((a) => a.words.length > 0)
    };

    if (payload.answers.length === 0) {
      errorMessage = 'Заполните хотя бы один ответ';
      screen = 'form';
      return;
    }

    screen = 'sending';
    try {
      const r = await fetch(`/api/surveys/${survey.code}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await r.json().catch(() => null);

      if (r.ok) {
        screen = 'sent';
        return;
      }
      if (r.status === 409) {
        screen = 'already';
        return;
      }
      if (r.status === 410) {
        screen = 'closed';
        return;
      }
      errorQuestionId = body?.error?.questionId ?? null;
      errorMessage = body?.error?.message ?? `Ошибка ${r.status}`;
      screen = 'form';
    } catch (e) {
      errorMessage = (e as Error).message;
      screen = 'form';
    }
  }
</script>

<svelte:head><title>{survey.title ?? 'Опрос'}</title></svelte:head>

{#if screen === 'closed'}
  <div class="state state-closed">
    <div class="state-icon" aria-hidden="true">⏳</div>
    <h1>Опрос завершён</h1>
    <p class="muted">Голосование больше не принимается.</p>
  </div>
{:else if screen === 'sent' || screen === 'already'}
  <div class="state {screen === 'already' ? 'state-already' : 'state-sent'}">
    <div class="state-icon" aria-hidden="true">✓</div>
    {#if screen === 'already'}
      <h1>Вы уже ответили</h1>
      <p class="muted">Ваш ответ записан. Спасибо за участие!</p>
    {:else}
      <h1>Спасибо!</h1>
      <p class="muted">Ваш ответ записан.</p>
    {/if}
  </div>
{:else}
  <h1>{survey.title ?? 'Опрос'}</h1>
  <p class="progress muted">
    Вопрос {currentIdx + 1} из {survey.questions.length}
  </p>

  {#key currentQuestion.id}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void answerCurrent();
      }}
    >
      <fieldset class="question" class:has-error={errorQuestionId === currentQuestion.id}>
        <legend id="q-{currentQuestion.id}-label">
          <span class="num">{currentIdx + 1}.</span>
          {currentQuestion.text}
        </legend>

        <input
          class="input"
          type="text"
          value={inputValue}
          oninput={(e) => (inputValue = stripWhitespace(e.currentTarget.value))}
          onkeydown={blockSpace}
          maxlength="50"
          placeholder="одно слово"
          autocomplete="off"
          aria-labelledby="q-{currentQuestion.id}-label"
          aria-describedby="q-{currentQuestion.id}-hint"
          aria-invalid={errorQuestionId === currentQuestion.id}
          disabled={reachedLimit && currentQuestion.answerType === 'multi'}
        />
        {#if spaceHint}
          <div class="hint hint-space" role="status">
            Только одно слово — пробелы не используются
          </div>
        {/if}
        {#if currentQuestion.answerType === 'multi'}
          <div class="hint" id="q-{currentQuestion.id}-hint">
            Ответов: {currentAnswers.length} / {currentMax}
          </div>
          {#if currentAnswers.length > 0}
            <ul class="chips">
              {#each currentAnswers as w, idx (idx)}
                <li class="chip">
                  <span>{w}</span>
                  <button
                    type="button"
                    class="chip-x"
                    onclick={() => removeWord(currentQuestion.id, idx)}
                    aria-label="Удалить слово"
                  >
                    ×
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          <div class="hint" id="q-{currentQuestion.id}-hint">Только одно слово, без пробелов</div>
        {/if}
      </fieldset>

      {#if errorMessage}
        <div class="alert alert-error" role="alert">{errorMessage}</div>
      {/if}

      <div class="actions">
        <!-- single — одна кнопка «Ответить», она же сразу переключает на
             следующий вопрос (или submit на последнем).
             multi — две кнопки: «Ответить» добавляет слово в буфер и
             остаётся на вопросе; «Следующий вопрос» уходит дальше
             (или submit на последнем). На последнем вопросе вместо
             «Следующий» — «Завершить». -->
        <button
          type="submit"
          class="btn btn-primary btn-lg"
          disabled={screen === 'sending' ||
            (currentQuestion.answerType === 'multi' && reachedLimit)}
        >
          {screen === 'sending' ? 'Отправляем…' : 'Ответить'}
        </button>
        {#if currentQuestion.answerType === 'multi'}
          <button
            type="button"
            class="btn btn-ghost btn-lg"
            disabled={screen === 'sending'}
            onclick={() => void nextOrSkip()}
          >
            {isLast ? 'Завершить' : 'Следующий вопрос'}
          </button>
        {/if}
      </div>
    </form>
  {/key}
{/if}

<style>
  h1 {
    margin-bottom: var(--space-2);
  }
  .muted {
    color: var(--c-muted);
  }
  .progress {
    margin-bottom: var(--space-4);
    font-size: 0.95rem;
  }

  .state {
    text-align: center;
    padding: var(--space-12) 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }
  .state-icon {
    font-size: 3.5rem;
    line-height: 1;
    margin-bottom: var(--space-2);
  }
  .state-sent .state-icon {
    color: var(--c-success);
  }
  .state-already .state-icon {
    color: var(--c-blue);
  }
  .state-closed .state-icon {
    color: var(--c-muted);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    margin-top: var(--space-4);
  }
  .question {
    background: var(--c-surface);
    border: 1px solid transparent;
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .question.has-error {
    border-color: var(--c-danger);
    background: var(--c-danger-bg);
  }
  legend {
    font-weight: 500;
    font-size: 1.0625rem;
    padding: 0;
    margin-bottom: var(--space-2);
  }
  .num {
    color: var(--c-muted);
    font-weight: 600;
    margin-right: var(--space-2);
  }
  .hint {
    color: var(--c-muted);
    font-size: 0.875rem;
  }
  .hint-space {
    color: var(--c-accent, #b45309);
    margin-top: var(--space-2);
  }
  .chips {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 12px;
    border: 1px solid var(--c-border);
    border-radius: 999px;
    background: var(--c-surface);
    font-size: 0.95rem;
  }
  .chip-x {
    border: none;
    background: transparent;
    color: var(--c-muted);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 2px;
  }
  .chip-x:hover {
    color: var(--c-danger);
  }
  .alert {
    padding: var(--space-3);
    border-radius: var(--radius);
    border: 1px solid;
    font-size: 0.95rem;
  }
  .alert-error {
    background: var(--c-danger-bg);
    color: var(--c-danger);
    border-color: var(--c-danger-border);
  }
  .actions {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  @media (max-width: 480px) {
    form {
      gap: var(--space-4);
    }
    .question {
      padding: var(--space-3);
    }
    legend {
      font-size: 1rem;
    }
    .actions .btn-lg {
      flex: 1;
      width: 100%;
    }
  }
</style>
