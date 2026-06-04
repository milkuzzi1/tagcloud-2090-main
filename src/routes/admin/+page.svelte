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
        createError = body.error?.message ?? '\u041e\u0448\u0438\u0431\u043a\u0430';
        return;
      }
      createMsg = `\u0421\u0441\u044b\u043b\u043a\u0430 \u0434\u043b\u044f \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438 \u043f\u0430\u0440\u043e\u043b\u044f \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0430 \u043d\u0430 ${createEmail}${body.ttlHours ? ` (\u0434\u0435\u0439\u0441\u0442\u0432\u0443\u0435\u0442 ${body.ttlHours}\u00a0\u0447)` : ''}`;
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
        inviteError = body.error?.message ?? '\u041e\u0448\u0438\u0431\u043a\u0430';
        return;
      }
      inviteMsg = '\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e';
      // Avoid duplicates: only add if not already in list
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
    const r = await fetch(`/api/admin/users/${removingId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepData })
    });
    if (r.ok) {
      members = members.filter((m) => m.id !== removingId);
      removingId = null;
    } else {
      const body = await r.json().catch(() => ({}));
      removeError = body.error?.message ?? '\u041e\u0448\u0438\u0431\u043a\u0430';
    }
  }
</script>

<svelte:head><title>\u0410\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440 \u2014 \u041e\u0431\u043b\u0430\u043a\u043e \u0442\u0435\u0433\u043e\u0432 2090</title></svelte:head>

<div class="page">
  <h1>\u0410\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440</h1>

  <!-- Create admin -->
  <section>
    <h2>\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u0430\u0434\u043c\u0438\u043d\u0430</h2>
    <p class="muted">\u0423\u043a\u0430\u0436\u0438\u0442\u0435 email \u2014 \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u043c \u0441\u0441\u044b\u043b\u043a\u0443 \u0434\u043b\u044f \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438 \u043f\u0430\u0440\u043e\u043b\u044f.</p>
    <form onsubmit={(e) => { e.preventDefault(); createAdmin(); }}>
      <input class="input" type="email" bind:value={createEmail} placeholder="admin@example.com" required maxlength="254" />
      <button type="submit" class="btn btn-primary" disabled={creating}>
        {creating ? '\u0421\u043e\u0437\u0434\u0430\u0451\u043c...' : '\u0421\u043e\u0437\u0434\u0430\u0442\u044c'}
      </button>
    </form>
    {#if createMsg}<p class="success">{createMsg}</p>{/if}
    {#if createError}<p class="error">{createError}</p>{/if}
  </section>

  <!-- Invites -->
  <section>
    <h2>\u0414\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u044b\u0435 email</h2>
    <form onsubmit={(e) => { e.preventDefault(); addInvite(); }}>
      <input class="input" type="email" bind:value={inviteEmail} placeholder="user@example.com" required maxlength="254" />
      <input class="input" type="text" bind:value={inviteNote} placeholder="\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u0435 (\u043d\u0435\u043e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u044c\u043d\u043e)" maxlength="200" />
      <button type="submit" class="btn btn-primary" disabled={addingInvite}>
        {addingInvite ? '\u0414\u043e\u0431\u0430\u0432\u043b\u044f\u0435\u043c...' : '\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c'}
      </button>
    </form>
    {#if inviteMsg}<p class="success">{inviteMsg}</p>{/if}
    {#if inviteError}<p class="error">{inviteError}</p>{/if}

    {#if invites.length === 0}
      <p class="muted">\u041f\u0440\u0438\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0439 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.</p>
    {:else}
      <ul class="list">
        {#each invites as inv (inv.id)}
          <li>
            <span class="email">{inv.email}</span>
            {#if inv.note}<span class="note">{inv.note}</span>{/if}
            {#if inv.registered}
              <span class="badge badge-ok">\u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u043d</span>
            {:else}
              <span class="badge badge-muted">\u043e\u0436\u0438\u0434\u0430\u0435\u0442</span>
            {/if}
            <button class="btn btn-sm btn-danger" onclick={() => removeInvite(inv.id)}>\u0423\u0434\u0430\u043b\u0438\u0442\u044c</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Members -->
  <section>
    <h2>\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0438</h2>
    {#if members.length === 0}
      <p class="muted">\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u0439 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.</p>
    {:else}
      <ul class="list">
        {#each members as m (m.id)}
          <li>
            <span class="email">{m.email}</span>
            {#if m.role === 'admin'}<span class="badge badge-admin">\u0430\u0434\u043c\u0438\u043d</span>{/if}
            {#if !m.emailVerified}<span class="badge badge-muted">\u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d</span>{/if}
            {#if m.id === data.currentUserId}<span class="badge badge-you">\u0432\u044b</span>{/if}
            {#if m.id !== data.currentUserId}
              <button class="btn btn-sm btn-danger" onclick={() => openRemove(m.id)}>\u0423\u0434\u0430\u043b\u0438\u0442\u044c</button>
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
      <h2>\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f?</h2>
      <p>\u0423\u0434\u0430\u043b\u0438\u0442\u044c <strong>{target?.email}</strong></p>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={keepData} />
        \u041e\u0441\u0442\u0430\u0432\u0438\u0442\u044c \u0434\u0430\u043d\u043d\u044b\u0435 \u0432 \u0411\u0414
      </label>
      <p class="hint muted">
        {keepData
          ? '\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u043d\u0435 \u0441\u043c\u043e\u0436\u0435\u0442 \u0432\u043e\u0439\u0442\u0438, \u043d\u043e \u0434\u0430\u043d\u043d\u044b\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u0441\u044f.'
          : '\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0438 \u0432\u0441\u0435 \u0435\u0433\u043e \u0434\u0430\u043d\u043d\u044b\u0435 \u0431\u0443\u0434\u0443\u0442 \u0443\u0434\u0430\u043b\u0435\u043d\u044b.'}
      </p>
      {#if removeError}<p class="error">{removeError}</p>{/if}
      <div class="modal-actions">
        <button class="btn" onclick={() => (removingId = null)}>\u041e\u0442\u043c\u0435\u043d\u0430</button>
        <button class="btn btn-danger" onclick={confirmRemove}>\u0423\u0434\u0430\u043b\u0438\u0442\u044c</button>
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
