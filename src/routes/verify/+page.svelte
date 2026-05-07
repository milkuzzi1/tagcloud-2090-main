<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let resendEmail = $state('');
  let resending = $state(false);
  let resendDone = $state(false);

  async function resend() {
    if (!resendEmail) return;
    resending = true;
    try {
      await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: resendEmail })
      });
      resendDone = true;
    } finally {
      resending = false;
    }
  }
</script>

<svelte:head><title>Подтверждение email — Облако тегов 2090</title></svelte:head>

<div class="auth">
  <h1>Подтверждение email</h1>
  {#if data.code === 'missing'}
    <div class="alert alert-error" role="alert">
      {data.message}. Откройте ссылку из письма целиком.
    </div>
  {:else if data.code === 'invalid'}
    <div class="alert alert-error" role="alert">
      Ссылка недействительна. Возможно, она была изменена.
    </div>
  {:else if data.code === 'used'}
    <div class="alert alert-error" role="alert">
      Эта ссылка уже была использована. Если у вас не получается войти — запросите новую.
    </div>
  {:else if data.code === 'expired'}
    <div class="alert alert-error" role="alert">
      Срок действия ссылки истёк. Запросите новое письмо ниже.
    </div>
  {/if}

  {#if data.code === 'expired' || data.code === 'used' || data.code === 'invalid'}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        resend();
      }}
    >
      <label>
        <span>Email, на который пришло письмо</span>
        <input
          class="input"
          type="email"
          bind:value={resendEmail}
          required
          autocomplete="email"
          maxlength="254"
        />
      </label>
      <button type="submit" class="btn btn-primary btn-block" disabled={resending || resendDone}>
        {#if resendDone}
          Отправлено
        {:else if resending}
          Отправляем…
        {:else}
          Отправить новое письмо
        {/if}
      </button>
      {#if resendDone}
        <p class="muted">
          Если этот email действительно зарегистрирован и ещё не подтверждён, на него отправлено
          письмо.
        </p>
      {/if}
    </form>
  {/if}

  <p class="footer-link"><a href="/login">Назад ко входу</a></p>
</div>

<style>
  .auth {
    max-width: 480px;
    margin: 0 auto;
  }
  h1 {
    margin-bottom: var(--space-4);
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
    font-size: 0.95rem;
  }
  .alert-error {
    background: var(--c-danger-bg);
    color: var(--c-danger);
    border-color: var(--c-danger-border);
  }
  .muted {
    color: var(--c-muted);
    font-size: 0.9rem;
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
