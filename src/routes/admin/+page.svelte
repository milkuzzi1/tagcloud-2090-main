<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Split members reactively
  let members = $state(data.members);
  let admins = $derived(members.filter((m) => m.role === 'admin'));
  let users = $derived(members.filter((m) => m.role !== 'admin'));

  // --- Create admin ---
  let createEmail = $state('');
  let creating = $state(false);
  let createMsg = $state<string | null>(null);
  let createError = $state<string | null>(null);

  async function createAdmin() {
    creating = true;
    createMsg = null;
    createError = null;
    try {
      const r = await fetch('/api/admin/create-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: createEmail })
      });
      const body = await r.json();
      if (!r.ok) {
        createError = body.error?.message ?? 'Ошибка';
        return;
      }
      createMsg = `Ссылка для установки пароля отправлена на ${createEmail}`;
      // Add placeholder to admins list so it appears immediately
      members = [
        ...members,
        {
          id: body.userId ?? crypto.randomUUID(),
          email: createEmail,
          role: 'admin',
          note: null,
          createdAt: new Date(),
          emailVerified: false
        }
      ];
      createEmail = '';
    } finally {
      creating = false;
    }
  }

  // --- Remove member ---
  let removingId = $state<string | null>(null);
  let keepData = $state(true);
  let removeError = $state<string | null>(null);

  function openRemove(id: string) {
    removingId = id;
    removeError = null;
  }

  async function confirmRemove() {
    if (!removingId) return;
    removeError = null;
    try {
      const r = await fetch(`/api/admin/users/${removingId}?keepData=${keepData}`, {
        method: 'DELETE'
      });
      if (r.ok) {
        members = members.filter((m) => m.id !== removingId);
        removingId = null;
        return;
      }
      let msg = 'Ошибка при удалении';
      try {
        const body = await r.json();
        if (body?.error?.code === 'last_admin') msg = 'Нельзя удалить последнего администратора';
        else if (body?.error?.code === 'self') msg = 'Нельзя удалить самого себя';
        else if (body?.error?.message) msg = body.error.message;
      } catch { /* empty body */ }
      removeError = msg;
    } catch {
      removeError = 'Сетевая ошибка';
    }
  }
</script>

<svelte:head><title>Администратор — Облако тегов 2090</title></svelte:head>

<div class="page">
  <h1>Администратор</h1>

  <!-- Admins list -->
  <section>
    <h2>Администраторы</h2>
    <p class="muted">Добавьте нового администратора — ему придёт письмо со ссылкой для установки пароля.</p>
    <form onsubmit={(e) => { e.preventDefault(); createAdmin(); }}>
      <input class="input" type="email" bind:value={createEmail} placeholder="admin@example.com" required maxlength="254" />
      <button type="submit" class="btn btn-primary" disabled={creating}>
        {creating ? 'Создаём...' : 'Добавить администратора'}
      </button>
    </form>
    {#if createMsg}<p class="success">{createMsg}</p>{/if}
    {#if createError}<p class="error">{createError}</p>{/if}

    {#if admins.length === 0}
      <p class="muted">Администраторов пока нет.</p>
    {:else}
      <ul class="list">
        {#each admins as m (m.id)}
          <li>
            <span class="email">{m.email}</span>
            {#if !m.emailVerified}<span class="badge badge-muted">не подтверждён</span>{/if}
            {#if m.id === data.currentUserId}
              <span class="badge badge-you">вы</span>
            {:else}
              <button class="btn btn-sm btn-danger" onclick={() => openRemove(m.id)}>Удалить</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Users list -->
  <section>
    <h2>Пользователи</h2>
    {#if users.length === 0}
      <p class="muted">Пользователей пока нет.</p>
    {:else}
      <ul class="list">
        {#each users as m (m.id)}
          <li>
            <span class="email">{m.email}</span>
            {#if !m.emailVerified}<span class="badge badge-muted">не подтверждён</span>{/if}
            <button class="btn btn-sm btn-danger" onclick={() => openRemove(m.id)}>Удалить</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<!-- Remove modal -->
{#if removingId}
  {@const target = members.find((m) => m.id === removingId)}
  <div class="modal-backdrop" role="presentation" onclick={() => (removingId = null)}>
    <div class="modal" role="dialog" onclick={(e) => e.stopPropagation()}>
      <h2>Удалить пользователя?</h2>
      <p>Удалить <strong>{target?.email}</strong></p>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={keepData} />
        Оставить данные в БД
      </label>
      <p class="hint muted">
        {keepData
          ? 'Пользователь не сможет войти, но данные сохранятся.'
          : 'Пользователь и все его данные будут удалены.'}
      </p>
      {#if removeError}<p class="error">{removeError}</p>{/if}
      <div class="modal-actions">
        <button class="btn" onclick={() => (removingId = null)}>Отмена</button>
        <button class="btn btn-danger" onclick={confirmRemove}>Удалить</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { max-width: 680px; margin: 0 auto; }
  h1 { margin-bottom: var(--space-6); }
  section { margin-bottom: var(--space-8); }
  h2 { margin-bottom: var(--space-3); }
  form { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
  .input { flex: 1; min-width: 180px; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .list li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-2) 0; border-bottom: 1px solid var(--c-border); }
  .email { font-weight: 500; flex: 1; }
  .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; font-weight: 500; }
  .badge-muted { background: var(--c-surface); color: var(--c-muted); border: 1px solid var(--c-border); }
  .badge-you { background: var(--c-surface); color: var(--c-muted); border: 1px solid var(--c-border); }
  .btn-sm { padding: 2px 10px; font-size: 0.8rem; }
  .success { color: var(--c-success); margin-top: var(--space-2); }
  .error { color: var(--c-danger); margin-top: var(--space-2); }
  .muted { color: var(--c-muted); }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: var(--c-bg); border-radius: var(--radius-lg); padding: var(--space-6); max-width: 400px; width: 100%; box-shadow: var(--shadow-lg); }
  .modal h2 { margin-bottom: var(--space-3); }
  .checkbox-label { display: flex; align-items: center; gap: var(--space-2); margin: var(--space-3) 0; cursor: pointer; }
  .hint { font-size: 0.85rem; }
  .modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; margin-top: var(--space-4); }
</style>
