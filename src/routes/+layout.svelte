<script lang="ts">
  import '../app.css';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  let { children, data } = $props();

  // Режим презентации (/p/[code]) рисует облако на всю ширину viewport'а,
  // поэтому снимаем max-width/padding с main.container только для этого
  // маршрута. Раньше сброс жил в +page.svelte через :global(main.container)
  // и протекал: ховер по ссылке «Режим презентации» триггерил SvelteKit
  // preload, а preload добавлял CSS в <head> навсегда (до следующего
  // full reload), и все страницы ломались по всей ширине.
  const isFullbleed = $derived(page.route.id === '/p/[code]');
  // Чистый просмотр облака (/c/[code]) открывается в отдельной вкладке и
  // не должен показывать шапку/футер/навигацию — кроме самого облака на
  // странице ничего быть не должно (правка №2).
  const isChromeless = $derived(page.route.id === '/c/[code]');

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await invalidateAll();
    await goto('/');
  }
</script>

{#if !isChromeless}
  <a class="skip-link" href="#main">Перейти к содержимому</a>

  <header class="topbar">
    <a class="brand" href={data.user ? '/my' : '/'}>
      <img class="brand-logo" src="/logo2090.png" alt="Школа №2090" />
      <span class="brand-text">Облако тегов</span>
    </a>

    <nav class="nav" aria-label="Основная навигация">
      {#if data.user}
        <a class="nav-link" href="/my" aria-current={page.route.id === '/my' ? 'page' : undefined}>
          Мои опросы
        </a>
        {#if data.user.role === 'admin'}
          <a
            class="nav-link"
            href="/admin"
            aria-current={page.route.id === '/admin' ? 'page' : undefined}
          >
            Админка
          </a>
        {/if}
        <button type="button" class="btn btn-ghost btn-sm" onclick={logout}>Выход</button>
      {:else}
        <a class="nav-link" href="/login">Войти</a>
      {/if}
    </nav>
  </header>
{/if}

<main id="main" class="container" class:fullbleed={isFullbleed} class:chromeless={isChromeless}>
  {@render children()}
</main>

{#if !isChromeless}
  <footer class="footer">
    <span>Школа №2090 · образовательный проект</span>
  </footer>
{/if}

<style>
  .topbar {
    border-bottom: 1px solid var(--c-border);
    padding: var(--space-3) var(--space-6);
    background: var(--c-bg);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    position: relative;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--c-navy);
    font-weight: 600;
    text-decoration: none;
    min-width: 0;
  }
  .brand:hover {
    text-decoration: none;
  }
  .brand-logo {
    height: 56px;
    width: 56px;
    object-fit: contain;
    display: block;
    flex-shrink: 0;
  }
  .brand-text {
    color: var(--c-text);
    font-weight: 500;
    font-size: 1.0625rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }
  .nav-link {
    color: var(--c-navy);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    padding: 6px 4px;
  }
  .nav-link:hover {
    text-decoration: underline;
  }
  .nav-link[aria-current='page'] {
    color: var(--c-navy);
    text-decoration: underline;
    text-underline-offset: 4px;
  }

  .container {
    max-width: 880px;
    margin: 0 auto;
    padding: var(--space-8) var(--space-6);
    min-height: calc(100vh - 130px);
  }
  /* Режим презентации: облако + сайдбар прижимаются
     к краям экрана. Класс ставится по route.id, так что SSR
     рендерит сразу в full-bleed без flash'а. */
  .container.fullbleed {
    max-width: none;
    padding: 0;
  }
  /* Chromeless: страница облака в отдельной вкладке — ни шапки, ни
     футера, ни отступов. Заполняет всю высоту окна, чтобы canvas мог
     раскрыться на весь экран. */
  .container.chromeless {
    max-width: none;
    padding: 0;
    margin: 0;
    min-height: 100vh;
  }
  .footer {
    border-top: 1px solid var(--c-border);
    padding: var(--space-4) var(--space-6);
    color: var(--c-muted);
    font-size: 0.875rem;
    text-align: center;
  }

  @media (max-width: 640px) {
    .topbar {
      padding: var(--space-3) var(--space-4);
    }
    .brand-logo {
      height: 44px;
      width: 44px;
    }
    .brand-text {
      font-size: 0.95rem;
    }
    .container {
      padding: var(--space-6) var(--space-4);
      min-height: calc(100vh - 160px);
    }
    .container.fullbleed {
      padding: 0;
      min-height: calc(100vh - 160px);
    }
  }
</style>
