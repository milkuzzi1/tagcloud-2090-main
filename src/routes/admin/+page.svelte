<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // --- Create admin ---
  let createEmail = $state('');
  let creating = $state(false);
  let createMsg = $state<string | null>(null);
  let createError = $state<string | null>(null);
  let members = $state(data.members);

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
      createMsg = `Ссылка для установки пароля отправлена на ${createEmail}${body.ttlHours ? ` (действует ${body.ttlHours} ч)` : ''}`;
      createEmail = '';
    } finally {
      creating = false;
    }
  }

  // --- Invites ---
  let inviteEmail = $state('');
  let inviteNote = $state('');
  let addingInvite = $state(false);
  let inviteMsg = $state<string | null>(null);
  let inviteError = $state<string | null>(null);
  let invites = $state(data.invites);

  async function addInvite() {
    addingInvite = true;
    inviteMsg = null;
    inviteError = null;
    try {
      const r = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, note: inviteNote || undefined })
      });
      const body = await r.json();
      if (!r.ok) {
        inviteError = body.error?.message ?? 'Ошибка';
        return;
      }
      inviteMsg = 'Добавлено';
      if (body.invite && !invites.some((i) => i.id === body.invite.id)) {
        invites = [...invites, body.invite];
      }
      inviteEmail = '';
      inviteNote = '';
    } finally {
      addingInvite = false;
    }
  }

  async function removeInvite(id: string) {
    const r = await fetch(`/api/admin/invites/${id}`, { method: 'DELETE' });
    if (r.ok) invites = invites.filter((i) => i.id !== id);
  }

  // --- Members ---
  let removingId = $state<string | null>(null);
  let keepData = $state(true);
  let removeError = $state<string | null>(null);

  function openRemove(id: string) {
    removingId = id;
    removeError = null;
  }

  async function confirmRemove() {
    if (!removingId) return;
    // Server reads keepData from query string, not body
    const r = await fetch(`/api/admin/users/${removingId}?keepData=${keepData}`, {
      method: 'DELETE'
    });
    if (r.ok) {
      members = members.filter((m) => m.id !== removingId);
      removingId = null;
    } else {
      const body = await r.json().catch(() => ({}));
      removeError = body.error?.message ?? 'Ошибка';
    }
  }
</script>

<svelte:head><title>Администратор — Облако тегов 2090</title></svelte:head>

<div class="page">
  <h1>Администратор</h1>

  <!-- Create admin -->
  <section>
    <h2>Создать админа</h2>
    <p class="muted">Укажите email — отправим ссылку для установки пароля.</p>
    <form onsubmit={(e) => { e.preventDefault(); createAdmin(); }}>
      <input class="input" type="email" bind:value={createEmail} placeholder="admin@example.com" required maxlength="254" />
      <button type="submit" class="btn btn-primary" disabled={creating}>
        {creating ? 'Создаём...' : 'Создать'}
      </button>
    </form>
    {#if createMsg}<p class="success">{createMsg}</p>{/if}
    {#if createError}<p class="error">{createError}</p>{/if}
  </section>

  <!-- Invites -->
  <section>
    <h2>Допущенные email</h2>
    <form onsubmit={(e) => { e.preventDefault(); addInvite(); }}>
      <input class="input" type="email" bind:value={inviteEmail} placeholder="user@example.com" required maxlength="254" />
      <input class="input" type="text" bind:value={inviteNote} placeholder="Примечание (необязательно)" maxlength="200" />
      <button type="submit" class="btn btn-primary" disabled={addingInvite}>
        {addingInvite ? 'Добавляем...' : 'Добавить'}
      </button>
    </form>
    {#if inviteMsg}<p class="success">{inviteMsg}</p>{/if}
    {#if inviteError}<p class="error">{inviteError}</p>{/if}

    {#if invites.length === 0}
      <p class="muted">Приглашений пока нет.</p>
    {:else}
      <ul class="list">
        {#each invites as inv (inv.id)}
          <li>
            <span class="email">{inv.email}</span>
            {#if inv.note}<span class="note">{inv.note}</span>{/if}
            {#if inv.registered}
              <span class="badge badge-ok">зарегистрирован</span>
            {:else}
              <span class="badge badge-muted">ожидает</span>
            {/if}
            <button class="btn btn-sm btn-danger" onclick={() => removeInvite(inv.id)}>Удалить</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Members -->
  <section>
    <h2>Пользователи</h2>
    {#if members.length === 0}
      <p class="muted">Пользователей пока нет.</p>
    {:else}
      <ul class="list">
        {#each members as m (m.id)}
          <li>
            <span class="email">{m.email}</span>
            {#if m.role === 'admin'}<span class="badge badge-admin">админ</span>{/if}
            {#if !m.emailVerified}<span class="badge badge-muted">не подтверждён</span>{/if}
            {#if m.id === data.currentUserId}<span class="badge badge-you">вы</span>{/if}
            {#if m.id !== data.currentUserId}
              <button class="btn btn-sm btn-danger" onclick={() => openRemove(m.id)}>Удалить</button>
            {/if}
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
  .email { font-weight: 500; }
  .note { color: var(--c-muted); font-size: 0.85rem; }
  .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; font-weight: 500; }
  .badge-ok { background: var(--c-success-bg); color: var(--c-success); }
  .badge-muted { background: var(--c-surface); color: var(--c-muted); border: 1px solid var(--c-border); }
  .badge-admin { background: var(--c-primary-bg, #e8f0fe); color: var(--c-primary, #1a56db); }
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
