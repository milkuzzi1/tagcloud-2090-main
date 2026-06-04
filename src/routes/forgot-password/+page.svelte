<script lang="ts">
  let email = $state('');
  let submitting = $state(false);
  let sent = $state(false);
  let ttlHours = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);

  async function submit() {
    submitting = true;
    errorMessage = null;
    try {
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const body = await r.json();
      if (!r.ok) {
        const issue = body.error?.issues?.[0];
        errorMessage = issue
          ? `${issue.path?.join('.') ?? ''}: ${issue.message}`
          : (body.error?.message ?? 'Ошибка');
        return;
      }
      ttlHours = body.ttlHours ?? null;
      sent = true;
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head><title>Восстановление пароль облако тегов 2090</title></svelte:head>

<div class="auth">
  {#if sent}
    <h1>Проверьте почту</h1>
    <p>
      Esli takoj adres est' v sisteme, my otpravili ssylku dlya sbrosa paroly na <b>{email}</b>.
    </p>
    {#if ttlHours}
      <p class="muted">Ссылка действует {ttlHours} ч.</p>
    {/if}
    <p class="footer-link"><a href="/login">Назад ко входу</a></p>
  {:else}
    <h1>Забыли пароль?</h1>
    <p class="muted">Введите email — пришлём ссылку для сброса.</p>
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
      {#if errorMessage}
        <div class="alert alert-error">{errorMessage}</div>
      {/if}
      <button type="submit" class="btn btn-primary btn-block" disabled={submitting}>
        {submitting ? 'Otpravlyaem...' : 'Отправить ссылку'}
      </button>
    </form>
    <p class="footer-link"><a href="/login">Вспомнил пароль</a></p>
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
