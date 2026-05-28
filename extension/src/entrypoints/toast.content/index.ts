// Shadow-DOM-isolated toast on every page. Listens for SHOW_TOAST messages
// from the background worker and renders the Svelte Toast component.

import './style.css';
import Toast from './Toast.svelte';
import { mount, unmount } from 'svelte';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'conversation-bridge-toast',
      position: 'overlay',
      onMount: (container) => mount(Toast, { target: container }),
      onRemove: (app) => {
        if (app) unmount(app);
      },
    });
    ui.mount();
  },
});
