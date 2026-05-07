<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';

  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let needsVerification = $state(false);
  let resending = $state(false);
  let resendDone = $state(false);

  async function submit() {
    submitting = true;
    errorMessage = null;
    needsVerification = false;
    resendDone = false;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const body = await r.json();
      if (!r.ok) {
        if (r.status === 403 && body.error?.code === 'email_not_verified') {
          needsVerification = true;
          return;
        }
        errorMessage = body.error?.message ?? 'Ошибка входа';
        return;
      }
      await invalidateAll();
      await goto('/my');
    } finally {
      submitting = false;
    }
  }

  async function resend() {
    resending = true;
    try {
      await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email })
      });
      resendDone = true;
    } finally {
      resending = false;
    }
  }
</script>

<svelte:head><title>Войти — Облако тегов 2090</title></svelte:head>

<div class="auth">
  <h1>Вход</h1>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      submit();
    }}
  >
    <label>
      <span>Email</span>
      <input
        class="input"
        type="email"
        bind:value={email}
        required
        autocomplete="email"
        maxlength="254"
      />
    </label>
    <label>
      <span>Пароль</span>
      <input
        class="input"
        type="password"
        bind:value={password}
        required
        autocomplete="current-password"
        minlength="8"
        maxlength="72"
      />
    </label>
    {#if errorMessage}
      <div class="alert alert-error" role="alert">{errorMessage}</div>
    {/if}
    {#if needsVerification}
      <div class="alert alert-warn" role="alert">
        <p>Email не подтверждён. Откройте письмо со ссылкой или запросите новое.</p>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onclick={resend}
          disabled={resending || resendDone}
        >
          {#if resendDone}
            Письмо отправлено
          {:else if resending}
            Отправляем…
          {:else}
            Переотправить письмо
          {/if}
        </button>
      </div>
    {/if}
    <button type="submit" class="btn btn-primary btn-block" disabled={submitting}>
      {submitting ? 'Входим…' : 'Войти'}
    </button>
  </form>
  <p class="footer-link">Нет аккаунта? <a href="/register">Регистрация</a></p>
</div>

<style>
  .auth {
    max-width: 400px;
    margin: 0 auto;
  }
  h1 {
    margin-bottom: var(--space-6);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    background: var(--c-surface);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
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
  .alert-warn {
    background: var(--c-warn-bg);
    color: var(--c-warn-fg);
    border-color: var(--c-warn-border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .alert-warn p {
    margin: 0;
  }
  .footer-link {
    color: var(--c-muted);
    margin-top: var(--space-4);
    text-align: center;
  }

  @media (max-width: 480px) {
    .auth {
      max-width: 100%;
    }
    form {
      padding: var(--space-4);
    }
  }
</style>
