<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let password = $state('');
  let confirm = $state('');
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let done = $state(false);

  async function submit() {
    if (password !== confirm) {
      errorMessage = 'Пароли не совпадают';
      return;
    }
    submitting = true;
    errorMessage = null;
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: data.token, password })
      });
      const body = await r.json();
      if (!r.ok) {
        const issue = body.error?.issues?.[0];
        errorMessage = issue
          ? `${issue.path?.join('.') ?? ''}: ${issue.message}`
          : (body.error?.message ?? 'Ошибка');
        return;
      }
      done = true;
      await invalidateAll();
      setTimeout(() => {
        window.location.href = '/my';
      }, 800);
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head><title>Новый пароль — Облако тегов 2090</title></svelte:head>

<div class="auth">
  {#if !data.state.ok}
    <h1>Ссылка не работает</h1>
    <p class="alert alert-error">{data.state.message}</p>
    <p class="footer-link"><a href="/forgot-password">Запросить новую ссылку</a></p>
  {:else if done}
    <h1>Готово</h1>
    <p>Пароль обновлён. Перенаправляем в личный кабинет…</p>
  {:else}
    <h1>Новый пароль</h1>
    <p class="muted">Введите новый пароль — старые сессии будут завершены.</p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        <span>Новый пароль (минимум 8 символов)</span>
        <input
          class="input"
          type="password"
          bind:value={password}
          required
          autocomplete="new-password"
          minlength="8"
          maxlength="72"
        />
      </label>
      <label>
        <span>Подтвердите пароль</span>
        <input
          class="input"
          type="password"
          bind:value={confirm}
          required
          autocomplete="new-password"
          minlength="8"
          maxlength="72"
        />
      </label>
      {#if errorMessage}
        <div class="alert alert-error">{errorMessage}</div>
      {/if}
      <button type="submit" class="btn btn-primary btn-block" disabled={submitting}>
        {submitting ? 'Сохраняем…' : 'Сохранить'}
      </button>
    </form>
  {/if}
</div>

<style>
  .auth {
    max-width: 440px;
    margin: 0 auto;
  }
  h1 {
    margin-bottom: var(--space-2);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    background: var(--c-surface);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    margin-top: var(--space-4);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  label > span {
    font-weight: 500;
  }
  .alert {
    padding: var(--space-3);
    border-radius: var(--radius);
    border: 1px solid;
    font-size: 0.9rem;
  }
  .alert-error {
    background: var(--c-danger-bg);
    color: var(--c-danger);
    border-color: var(--c-danger-border);
  }
  .muted {
    color: var(--c-muted);
    margin-top: var(--space-3);
  }
  .footer-link {
    color: var(--c-muted);
    margin-top: var(--space-3);
    text-align: center;
  }
</style>
