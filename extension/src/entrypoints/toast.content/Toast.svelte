<script lang="ts">
  import { onMount } from 'svelte';
  import type { ToastData } from '../../lib/messages';

  let toasts = $state<ToastData[]>([]);

  onMount(() => {
    const listener = (msg: unknown) => {
      const m = msg as { type?: string; toast?: ToastData };
      if (m?.type === 'SHOW_TOAST' && m.toast) {
        toasts = [...toasts, m.toast];
        const id = m.toast.id;
        setTimeout(() => {
          toasts = toasts.filter(t => t.id !== id);
        }, 4000);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  });

  function dismiss(id: string): void {
    toasts = toasts.filter(t => t.id !== id);
  }
</script>

<div class="stack">
  {#each toasts as t (t.id)}
    <button class="toast variant-{t.variant}" onclick={() => dismiss(t.id)} aria-label="Dismiss toast">
      <strong>{t.title}</strong>
      <span>{t.message}</span>
    </button>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    top: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 2147483647;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 14px;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    border: 1px solid #e4e4e7;
    background: white;
    color: #18181b;
    font-size: 12px;
    cursor: pointer;
    max-width: 320px;
    text-align: left;
  }
  .toast strong {
    font-size: 11px;
    font-weight: 600;
    color: #3f3f46;
  }
  .variant-success {
    border-color: #bbf7d0;
    background: #f0fdf4;
  }
  .variant-error {
    border-color: #fecaca;
    background: #fef2f2;
  }
  .variant-info {
    border-color: #c7d2fe;
    background: #eef2ff;
  }
</style>
