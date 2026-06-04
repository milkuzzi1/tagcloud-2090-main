<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Initial values seeded from the load() data. These lists are then mutated
  // locally for optimistic UI (add/remove invite, remove member, email change),
  // so they are $state, not $derived. Reading the props once here is
  // intentional (snapshot), hence the indirection to avoid the
  // state_referenced_locally hint.
  const initial = data;

  // --- Members ---
  let members = $state(initial.members);
  let admins = $derived(members.filter((m) => m.role === 'admin'));
  let users = $derived(members.filter((m) => m.role !== 'admin'));

  // --- Allowlist invites (Req 4a / Req 5) ---
  let invites = $state(initial.invites);
  let inviteEmail = $state('');
  let inviteNote = $state('');
  let invitingBusy = $state(false);
  let inviteMsg = $state<string | null>(null);
  let inviteError = $state<string | null>(null);

  async function addInvite() {
    invitingBusy = true;
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
      inviteMsg = body.sent
        ? `Приглашение отправлено на ${inviteEmail}`
        : `${inviteEmail} уже в списке`;
      if (body.invite) {
        invites = [...invites.filter((i) => i.email !== body.invite.email), body.invite];
      }
      inviteEmail = '';
      inviteNote = '';
    } finally {
      invitingBusy = false;
    }
  }

  async function removeInvite(id: string, email: string) {
    const r = await fetch(`/api/admin/invites/${id}`, { method: 'DELETE' });
    if (r.ok) invites = invites.filter((i) => i.email !== email);
  }

  // --- Change admin email (Req 4b) ---
  let newEmail = $state(initial.currentUserEmail);
  let currentPassword = $state('');
  let emailBusy = $state(false);
  let emailMsg = $state<string | null>(null);
  let emailError = $state<string | null>(null);

  async function changeEmail() {
    emailBusy = true;
    emailMsg = null;
    emailError = null;
    try {
      const r = await fetch('/api/admin/change-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newEmail, currentPassword })
      });
      const body = await r.json();
      if (!r.ok) {
        emailError = body.error?.message ?? 'Ошибка';
        return;
      }
      emailMsg = `Email изменён на ${body.email}`;
      currentPassword = '';
      members = members.map((m) => (m.id === data.currentUserId ? { ...m, email: body.email } : m));
    } finally {
      emailBusy = false;
    }
  }

  // --- Transfer administration (Req 2). Only the sole admin may transfer. ---
  let canTransfer = $derived(data.adminCount === 1);
  let transferEmail = $state('');
  let transferKeepData = $state(false);
  let transferBusy = $state(false);
  let transferMsg = $state<string | null>(null);
  let transferError = $state<string | null>(null);

  async function transferAdmin() {
    transferBusy = true;
    transferMsg = null;
    transferError = null;
    try {
      const r = await fetch('/api/admin/transfer-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: transferEmail, keepData: transferKeepData })
      });
      const body = await r.json();
      if (!r.ok) {
        transferError = body.error?.message ?? 'Ошибка';
        return;
      }
      transferMsg = `Новому администратору (${body.email}) отправлено письмо. Ваш аккаунт будет удалён после того, как он задаст пароль.`;
      transferEmail = '';
    } finally {
      transferBusy = false;
    }
  }

  // --- Remove member (Req 6) ---
  let removingId = $state<string | null>(null);
  let keepData = $state(true);
  let removeError = $state<string | null>(null);

  function openRemove(id: string) {
    removingId = id;
    removeError = null;
  }

  // Focus the dialog on open so Escape works immediately and screen readers
  // move into the modal.
  function autofocus(node: HTMLElement) {
    node.focus();
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
        if (body?.error?.message) msg = body.error.message;
      } catch {
        /* empty body */
      }
      removeError = msg;
    } catch {
      removeError = 'Сетевая ошибка';
    }
  }
</script>

<svelte:head><title>Администратор — Облако тегов 2090</title></svelte:head>

<div class="page">
  <h1>Администратор</h1>

  <!-- Allowlist: add users allowed into the system (Req 4a / Req 5) -->
  <section>
    <h2>Доступ пользователей</h2>
    <p class="muted">
      Добавьте email — пользователю придёт приглашение со ссылкой, по которой он
      задаёт только пароль. Публичной регистрации нет.
    </p>
    <form onsubmit={(e) => { e.preventDefault(); addInvite(); }}>
      <input class="input" type="email" bind:value={inviteEmail} placeholder="user@example.com" required maxlength="254" aria-label="Email пользователя" />
      <input class="input input-note" type="text" bind:value={inviteNote} placeholder="заметка (необязательно)" maxlength="200" aria-label="Заметка" />
      <button type="submit" class="btn btn-primary" disabled={invitingBusy}>
        {invitingBusy ? 'Добавляем…' : 'Пригласить'}
      </button>
    </form>
    {#if inviteMsg}<p class="success">{inviteMsg}</p>{/if}
    {#if inviteError}<p class="error">{inviteError}</p>{/if}

    {#if invites.length > 0}
      <ul class="list">
        {#each invites as inv (inv.email)}
          <li>
            <span class="email">{inv.email}</span>
            {#if inv.note}<span class="note muted">{inv.note}</span>{/if}
            {#if inv.registered}
              <span class="badge badge-muted">зарегистрирован</span>
            {:else}
              <span class="badge badge-muted">ожидает</span>
            {/if}
            <button class="btn btn-sm btn-danger" onclick={() => removeInvite(inv.id, inv.email)}>Убрать</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Users list (Req 6: remove with keep-data choice) -->
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

  <!-- Change admin email (Req 4b) -->
  <section>
    <h2>Email администратора</h2>
    <p class="muted">Смена email вашей учётной записи. Требуется текущий пароль.</p>
    <form onsubmit={(e) => { e.preventDefault(); changeEmail(); }}>
      <input class="input" type="email" bind:value={newEmail} required maxlength="254" aria-label="Новый email" />
      <input class="input" type="password" bind:value={currentPassword} placeholder="текущий пароль" required autocomplete="current-password" aria-label="Текущий пароль" />
      <button type="submit" class="btn" disabled={emailBusy}>
        {emailBusy ? 'Сохраняем…' : 'Изменить email'}
      </button>
    </form>
    {#if emailMsg}<p class="success">{emailMsg}</p>{/if}
    {#if emailError}<p class="error">{emailError}</p>{/if}
  </section>

  <!-- Transfer administration (Req 2 + Req 3) -->
  <section>
    <h2>Администраторы</h2>
    <ul class="list">
      {#each admins as m (m.id)}
        <li>
          <span class="email">{m.email}</span>
          {#if !m.emailVerified}<span class="badge badge-muted">не активирован</span>{/if}
          {#if m.id === data.currentUserId}<span class="badge badge-you">вы</span>{/if}
        </li>
      {/each}
    </ul>

    {#if canTransfer}
      <p class="muted">
        Передать администрирование другому человеку. Ему придёт письмо со ссылкой
        для установки пароля. <strong>Ваша учётная запись будет удалена только
        после того, как новый администратор задаст пароль.</strong> Новый
        администратор не сможет создавать других администраторов.
      </p>
      <form onsubmit={(e) => { e.preventDefault(); transferAdmin(); }}>
        <input class="input" type="email" bind:value={transferEmail} placeholder="new-admin@example.com" required maxlength="254" aria-label="Email нового администратора" />
        <button type="submit" class="btn btn-danger" disabled={transferBusy}>
          {transferBusy ? 'Отправляем…' : 'Передать администрирование'}
        </button>
      </form>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={transferKeepData} />
        Сохранить данные моей учётной записи в БД после удаления
      </label>
      {#if transferMsg}<p class="success">{transferMsg}</p>{/if}
      {#if transferError}<p class="error">{transferError}</p>{/if}
    {:else}
      <p class="muted">
        Передача администрирования недоступна: она разрешена только когда в системе
        единственный администратор.
      </p>
    {/if}
  </section>
</div>

<!-- Remove modal (Req 6) -->
{#if removingId}
  {@const target = members.find((m) => m.id === removingId)}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={() => (removingId = null)}
    onkeydown={(e) => { if (e.key === 'Escape') removingId = null; }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-modal-title"
      tabindex="-1"
      use:autofocus
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h2 id="remove-modal-title">Удалить пользователя?</h2>
      <p>Удалить <strong>{target?.email}</strong></p>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={keepData} />
        Оставить данные в БД
      </label>
      <p class="hint muted">
        {keepData
          ? 'Пользователь не сможет войти, но данные сохранятся.'
          : 'Пользователь и все его данные будут удалены безвозвратно.'}
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
  .input-note { flex: 1; min-width: 140px; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .list li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-2) 0; border-bottom: 1px solid var(--c-border); }
  .email { font-weight: 500; flex: 1; }
  .note { font-size: 0.85rem; }
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
