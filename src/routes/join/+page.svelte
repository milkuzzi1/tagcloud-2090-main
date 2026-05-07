<script lang="ts">
  import { goto } from '$app/navigation';

  // Те же символы, что используем при генерации кода (без 0/O, 1/I/L), длина 6.
  const CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

  let code = $state('');
  let error = $state<string | null>(null);

  function normalize(v: string): string {
    return v
      .toUpperCase()
      .replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '')
      .slice(0, 6);
  }

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    code = normalize(e.currentTarget.value);
    error = null;
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!CODE_REGEX.test(code)) {
      error = 'Введите 6 символов: A–Z и цифры 2–9';
      return;
    }
    goto(`/r/${code}`);
  }
</script>

<svelte:head><title>Пройти опрос — Облако тегов 2090</title></svelte:head>

<section class="join">
  <h1>Пройти опрос</h1>
  <p class="muted">Введите код, который вам дал организатор.</p>

  <form onsubmit={submit}>
    <input
      class="input code-input"
      type="text"
      value={code}
      oninput={onInput}
      placeholder="ABCDEF"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      aria-label="Код опроса"
      maxlength="6"
      inputmode="text"
    />
    {#if error}
      <div class="alert alert-error" role="alert">{error}</div>
    {/if}
    <button type="submit" class="btn btn-primary btn-lg btn-block" disabled={code.length !== 6}>
      Пройти опрос
    </button>
  </form>
</section>

<style>
  .join {
    max-width: 360px;
    margin: var(--space-12) auto 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  h1 {
    margin: 0;
  }
  .muted {
    color: var(--c-muted);
    margin: 0 0 var(--space-4);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .code-input {
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.4em;
    font-size: 1.5rem;
    font-family: var(--font-mono);
    font-weight: 600;
    padding-block: var(--space-4);
  }
</style>
