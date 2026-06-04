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
        errorMessage = body.error?.message ?? 'ÐžÑˆÐ¸Ð±ÐºÐ° Ð²Ñ…Ð¾Ð´Ð°';
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

<svelte:head><title>Ð’Ñ…Ð¾Ð´ â€” ÐžÐ±Ð»Ð°ÐºÐ¾ Ñ‚ÐµÐ³Ð¾Ð² 2090</title></svelte:head>

<div class="auth">
  <h1>Ð’Ñ…Ð¾Ð´</h1>
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
      <span>ÐŸÐ°Ñ€Ð¾Ð»ÑŒ</span>
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
        <p>Email Ð½Ðµ Ð¿Ð¾Ð´Ñ‚Ð²ÐµÑ€Ð¶Ð´Ñ‘Ð½. ÐžÑ‚ÐºÑ€Ð¾Ð¹Ñ‚Ðµ Ð¿Ð¸ÑÑŒÐ¼Ð¾ ÑÐ¾ ÑÑÑ‹Ð»ÐºÐ¸ Ð¸Ð»Ð¸ Ð·Ð°Ð¿Ñ€Ð¾ÑÐ¸Ñ‚Ðµ Ð½Ð¾Ð²Ð¾Ðµ.</p>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onclick={resend}
          disabled={resending || resendDone}
        >
          {#if resendDone}
            ÐŸÐ¸ÑÑŒÐ¼Ð¾ Ð¾Ñ‚Ð¿Ñ€Ð°Ð²Ð»ÐµÐ½Ð¾
          {:else if resending}
            Otpravlyaem...
          {:else}
            Pereotpravit' pismo
          {/if}
        </button>
      </div>
    {/if}
    <button type="submit" class="btn btn-primary btn-block" disabled={submitting}>
      {submitting ? 'Ð’Ñ…Ð¾Ð´Ð¸Ð½...' : 'Ð’Ð¾Ð¹Ñ‚Ð¸'}
    </button>
  </form>
  <p class="footer-link"><a href="/forgot-password">Забыли пароль?</a></p>
  <p class="footer-link">ÐÐµÑ‚ Ð°ÐºÐºÐ°ÑƒÐ½Ñ‚Ð°? <a href="/register">Ð ÐµÐ³Ð¸ÑÑ‚Ñ€Ð°Ñ†Ð¸Ñ</a></p>
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
    margin-top: var(--space-3);
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
