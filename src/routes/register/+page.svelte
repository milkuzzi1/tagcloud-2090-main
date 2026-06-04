<script lang="ts">
  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let pending = $state<{ email: string; ttlHours: number; status: string } | null>(null);
  let resending = $state(false);
  let resendDone = $state(false);

  async function submit() {
    submitting = true;
    errorMessage = null;
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'user', email, password })
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
      pending = { email: body.email, ttlHours: body.ttlHours, status: body.status };
    } finally {
      submitting = false;
    }
  }

  async function resend() {
    if (!pending) return;
    resending = true;
    try {
      await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: pending.email })
      });
      resendDone = true;
    } finally {
      resending = false;
    }
  }
</script>

<svelte:head><title>Регистрация — Облако тегов 2090</title></svelte:head>

<div class="auth">
  {#if pending}
    <h1>Письмо отправлено</h1>
    <p>
      My otpravili sssylku dlya podtverzhdeniya na <b>{pending.email}</b>.
      Otkroyte pis&mo i nazhmite knopku.
    </p>
    <p class="muted">Ссылка действует {pending.ttlHours} ч.</p>
    <button
      type="button"
      class="btn btn-primary btn-block"
      onclick={resend}
      disabled={resending || resendDone}
    >
      {#if resendDone}
        Otpravleno
      {:else if resending}
        Otpravlyaem...
      {:else}
        Отправить письмо ещё раз
      {/if}
    </button>
    <p class="footer-link"><a href="/login">Назад ко входу</a></p>
  {:else}
    <h1>Регистрация</h1>
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
        {submitting ? 'Sozdaem...' : 'Создать аккаунт'}
      </button>
    </form>
    <p class="footer-link">Уже есть аккаунт? <a href="/login">Войти</a></p>
  {/if}
</div>

<style>
  .auth {
    max-width: 440px;
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
  .muted {
    color: var(--c-muted);
    margin-top: var(--space-3);
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
