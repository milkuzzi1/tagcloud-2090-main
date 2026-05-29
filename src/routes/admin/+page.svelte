<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let newEmail = $state('');
  let newNote = $state('');
  let inviteBusy = $state(false);
  let inviteError = $state<string | null>(null);
  let inviteOk = $state<string | null>(null);

  type Member = PageData['members'][number];
  let deleting = $state<Member | null>(null);
  let keepData = $state(false);
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);

  async function addInvite() {
    inviteBusy = true;
    inviteError = null;
    inviteOk = null;
    try {
      const r = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: newEmail, note: newNote || undefined })
      });
      const body = await r.json();
      if (!r.ok) {
        const issue = body.error?.issues?.[0];
        inviteError = issue
          ? `${issue.path?.join('.') ?? ''}: ${issue.message}`
          : (body.error?.message ?? 'Ошибка');
        return;
      }
      inviteOk = body.sent ? 'Приглашение отправлено' : 'Email уже в списке разрешённых';
      newEmail = '';
      newNote = '';
      await invalidateAll();
    } finally {
      inviteBusy = false;
    }
  }

  async function removeInvite(id: string) {
    const r = await fetch(`/api/admin/invites/${id}`, { method: 'DELETE' });
    if (r.ok) {
      await invalidateAll();
    }
  }

  function openDelete(m: Member) {
    deleting = m;
    keepData = false;
    deleteError = null;
  }

  function closeDelete() {
    deleting = null;
    deleteError = null;
  }

  async function confirmDelete() {
    if (!deleting) return;
    deleteBusy = true;
    deleteError = null;
    try {
      const r = await fetch(
        `/api/admin/users/${deleting.id}?keepData=${keepData ? 'true' : 'false'}`,
        { method: 'DELETE' }
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        deleteError = body.error?.message ?? 'Не удалось удалить пользователя';
        return;
      }
      deleting = null;
      await invalidateAll();
    } finally {
      deleteBusy = false;
    }
  }

  function formatDate(d: string | Date): string {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString('ru-RU');
  }
</script>

<svelte:head><title>Админка — {data.organizationName}</title></svelte:head>

<div class="admin">
  <header>
    <h1>Администрирование</h1>
    <p class="muted">Организация: <b>{data.organizationName}</b></p>
  </header>

  <section class="card">
    <h2>Разрешённые email-адреса</h2>
    <p class="muted lead">
      Пользователи могут регистрироваться, только если их email находится в этом списке. При
      добавлении мы отправляем приглашение со ссылкой на регистрацию.
    </p>

    <form
      class="invite-form"
      onsubmit={(e) => {
        e.preventDefault();
        addInvite();
      }}
    >
      <input
        class="input"
        type="email"
        placeholder="user@example.com"
        bind:value={newEmail}
        required
        maxlength="254"
      />
      <div class="row">
        <input
          class="input"
          type="text"
          placeholder="Заметка (необязательно)"
          bind:value={newNote}
          maxlength="200"
        />
        <button class="btn btn-primary" type="submit" disabled={inviteBusy}>
          {inviteBusy ? 'Добавляем…' : 'Добавить'}
        </button>
      </div>
    </form>
    {#if inviteError}
      <div class="alert alert-error">{inviteError}</div>
    {/if}
    {#if inviteOk}
      <div class="alert alert-ok">{inviteOk}</div>
    {/if}

    {#if data.invites.length === 0}
      <p class="muted">Пока никто не приглашён.</p>
    {:else}
      <ul class="list">
        {#each data.invites as inv (inv.id)}
          <li>
            <div class="li-main">
              <span class="email">{inv.email}</span>
              {#if inv.note}
                <span class="note muted">{inv.note}</span>
              {/if}
              {#if inv.registered}
                <span class="badge badge-ok">зарегистрирован</span>
              {:else}
                <span class="badge">ожидает</span>
              {/if}
            </div>
            <div class="li-meta">
              <span class="muted">{formatDate(inv.invitedAt)}</span>
              <button class="btn btn-ghost btn-sm" onclick={() => removeInvite(inv.id)}>
                Удалить
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card">
    <h2>Участники организации</h2>
    {#if data.members.length === 0}
      <p class="muted">Пока никого нет.</p>
    {:else}
      <ul class="list">
        {#each data.members as m (m.id)}
          <li>
            <div class="li-main">
              <span class="email">{m.email}</span>
              {#if m.note}
                <span class="note muted">{m.note}</span>
              {/if}
              {#if m.role === 'admin'}
                <span class="badge badge-admin">админ</span>
              {/if}
              {#if !m.emailVerified}
                <span class="badge">не подтверждён</span>
              {/if}
              {#if m.id === data.currentUserId}
                <span class="badge">это вы</span>
              {/if}
            </div>
            <div class="li-meta">
              <span class="muted">{formatDate(m.createdAt)}</span>
              {#if m.id !== data.currentUserId}
                <button class="btn btn-ghost btn-sm" onclick={() => openDelete(m)}>
                  Удалить
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

{#if deleting}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeDelete();
    }}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <h3 id="delete-title">Удалить пользователя?</h3>
      <p>
        Вы собираетесь удалить <b>{deleting.email}</b> из организации.
      </p>
      <label class="checkbox">
        <input type="checkbox" bind:checked={keepData} />
        <span>Оставить данные пользователя в базе данных</span>
      </label>
      <p class="muted hint">
        {#if keepData}
          Пользователь не сможет входить, но его опросы останутся. Можно будет восстановить позже.
        {:else}
          Будут удалены пользователь и все связанные данные (опросы, голоса).
        {/if}
      </p>
      {#if deleteError}
        <div class="alert alert-error">{deleteError}</div>
      {/if}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick={closeDelete} disabled={deleteBusy}>Отмена</button>
        <button class="btn btn-danger" onclick={confirmDelete} disabled={deleteBusy}>
          {deleteBusy ? 'Удаляем…' : 'Удалить'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .admin {
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  header h1 {
    margin: 0;
  }
  .card {
    background: var(--c-surface);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .card h2 {
    margin: 0;
  }
  .lead {
    margin: 0;
  }
  .invite-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .invite-form .row {
    display: flex;
    align-items: stretch;
    gap: var(--space-3);
  }
  .invite-form .row .input {
    flex: 1;
  }
  .note {
    font-size: 0.85rem;
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3);
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .li-main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .li-meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .email {
    font-weight: 500;
  }
  .badge {
    background: var(--c-surface-2, #eef0f3);
    color: var(--c-muted);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.75rem;
  }
  .badge-ok {
    background: var(--c-ok-bg, #e6f7ec);
    color: var(--c-ok, #2e7d4f);
  }
  .badge-admin {
    background: var(--c-info-bg, #e8eefb);
    color: var(--c-info, #2952b3);
  }
  .muted {
    color: var(--c-muted);
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
  .alert-ok {
    background: var(--c-ok-bg, #e6f7ec);
    color: var(--c-ok, #2e7d4f);
    border-color: var(--c-ok-border, #b6e3c6);
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    z-index: 50;
  }
  .modal {
    background: var(--c-surface);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
    box-shadow: var(--shadow-lg, 0 10px 25px rgba(0, 0, 0, 0.15));
    max-width: 480px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .modal h3 {
    margin: 0;
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .hint {
    margin: 0;
    font-size: 0.9rem;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }
</style>
