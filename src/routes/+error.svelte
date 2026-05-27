<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} — Облако тегов 2090</title></svelte:head>

<div class="wrap">
  <div class="status">{page.status}</div>
  <h1>{page.error?.message ?? 'Что-то пошло не так'}</h1>
  <a href="/" class="btn btn-primary">← На главную</a>
</div>

<style>
  .wrap {
    text-align: center;
    padding: var(--space-12) 0;
  }
  .status {
    font-size: 4rem;
    font-weight: 700;
    color: var(--c-navy);
    letter-spacing: -0.04em;
    line-height: 1;
  }
  h1 {
    margin: var(--space-4) 0 var(--space-8);
    color: var(--c-text);
    font-weight: 500;
  }
</style>
