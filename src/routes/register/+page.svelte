<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let password = $state('');
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let done = $state(false);

  async function submit() {
    submitting = true;
    errorMessage = null;
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: data.initialEmail, password })
      });
      const body = await r.json();
      if (!r.ok) {
        const issue = body.error?.issues?.[0];
        errorMessage = issue
          ? `${issue.path?.join('.') ?? ''}: ${issue.message}`
          : (body.error?.message ?? 'Ошибка');
        return;
      }
      if (body.autoVerified) {
        window.location.href = '/my';
        return;
      }
      done = true;
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head><title>Создание аккаунта — Облако тегов 2090</title></svelte:head>

<div class="auth">
  {#if done}
    <h1>Аккаунт создан</h1>
    <p>Войдите с вашим email и паролем.</p>
    <a class="btn btn-primary btn-block" href="/login">Войти</a>
  {:else}
    <h1>Создание аккаунта</h1>
    <p class="muted">Вы регистрируетесь как <b>{data.initialEmail}</b></p>
    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>
        <span>Пароль (минимум 8 символов)</span>
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
      {#if errorMessage}
        <div class="alert alert-error" role="alert">{errorMessage}</div>
      {/if}
      <button type="submit" class="btn btn-primary btn-block" disabled={submitting}>
        {submitting ? 'Создаём...' : 'Создать аккаунт'}
      </button>
    </form>
  {/if}
</div>

<style>
  .auth { max-width: 440px; margin: 0 auto; }
  h1 { margin-bottom: var(--space-2); }
  .muted { color: var(--c-muted); margin-bottom: var(--space-4); }
  form {
    display: flex; flex-direction: column; gap: var(--space-4);
    background: var(--c-surface); padding: var(--space-6);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
  }
  label { display: flex; flex-direction: column; gap: var(--space-2); }
  label > span { font-weight: 500; }
  .alert { padding: var(--space-3); border-radius: var(--radius); border: 1px solid; font-size: 0.9rem; }
  .alert-error { background: var(--c-danger-bg); color: var(--c-danger); border-color: var(--c-danger-border); }
  .btn-block { width: 100%; }
</style>
