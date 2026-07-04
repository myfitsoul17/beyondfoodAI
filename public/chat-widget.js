/**
 * Beyond Food AI Nutrition Expert — embeddable chat widget.
 *
 * Usage (put this near the end of <body> on any page):
 *   <script>
 *     window.BEYOND_FOOD_CHAT_API = "https://your-backend.example.com/api/chat";
 *   </script>
 *   <script src="/chat-widget.js"></script>
 *
 * The widget renders a floating launcher button (bottom-right) that
 * opens a chat panel. It never talks to OpenAI directly — only to
 * your own backend endpoint (server.js).
 */
(function () {
  const API_URL = window.BEYOND_FOOD_CHAT_API || '/api/chat';
  const STORAGE_KEY = 'bf_chat_history';

  const state = {
    open: false,
    loading: false,
    messages: loadHistory(), // [{role:'user'|'assistant', content:'...'}]
  };

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function saveHistory() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages)); } catch {}
  }

  // ---------- build DOM ----------
  const root = document.createElement('div');
  root.id = 'bf-chat-root';
  root.innerHTML = `
    <button id="bf-chat-launcher" aria-label="Open AI Nutrition Expert chat">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.35 0-2.62-.32-3.73-.9L3 21l1.9-5.77A8.5 8.5 0 1 1 21 11.5Z"/>
      </svg>
      <span>Ask AI</span>
    </button>

    <div id="bf-chat-panel" hidden>
      <div id="bf-chat-header">
        <div>
          <strong>Beyond Food AI</strong>
          <span>Nutrition Expert · powered by AI</span>
        </div>
        <button id="bf-chat-close" aria-label="Close chat">✕</button>
      </div>
      <div id="bf-chat-body"></div>
      <form id="bf-chat-form">
        <input id="bf-chat-input" type="text" placeholder="Ask anything about nutrition, products or your goals..." autocomplete="off" />
        <button type="submit" aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(root);

  const launcher = document.getElementById('bf-chat-launcher');
  const panel = document.getElementById('bf-chat-panel');
  const body = document.getElementById('bf-chat-body');
  const form = document.getElementById('bf-chat-form');
  const input = document.getElementById('bf-chat-input');
  const closeBtn = document.getElementById('bf-chat-close');

  launcher.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePanel(true);
});
closeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePanel(false);
});
  function togglePanel(open) {
    state.open = open;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      if (state.messages.length === 0) {
        pushMessage('assistant', "Hi! I'm the Beyond Food AI Nutrition Expert. Tell me your goal — weight loss, muscle gain, race prep — and any diet preferences, and I'll find the right products for you.");
      }
      input.focus();
    }
  }

  function pushMessage(role, content, products) {
    state.messages.push({ role, content });
    saveHistory();
    renderMessage(role, content, products);
    body.scrollTop = body.scrollHeight;
  }

  function renderMessage(role, content, products) {
    const wrap = document.createElement('div');
    wrap.className = 'bf-msg bf-msg-' + role;
    const bubble = document.createElement('div');
    bubble.className = 'bf-bubble';
    bubble.textContent = content;
    wrap.appendChild(bubble);

    if (products && products.length) {
      const cards = document.createElement('div');
      cards.className = 'bf-product-cards';
      products.forEach(p => {
        const card = document.createElement('a');
        card.className = 'bf-product-card';
        card.href = p.url || '#';
        card.innerHTML = `
          <div class="bf-pc-img" style="${p.image ? `background-image:url('${p.image}')` : ''}"></div>
          <div class="bf-pc-info">
            <div class="bf-pc-name">${escapeHtml(p.name)}</div>
            <div class="bf-pc-tags">${(p.tags || []).map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
            <div class="bf-pc-desc">${escapeHtml(p.description || '')}</div>
            <div class="bf-pc-cta">View Product →</div>
          </div>
        `;
        cards.appendChild(card);
      });
      wrap.appendChild(cards);
    }
    body.appendChild(wrap);
  }

  function renderTyping(show) {
    let el = document.getElementById('bf-typing');
    if (show) {
      if (el) return;
      el = document.createElement('div');
      el.id = 'bf-typing';
      el.className = 'bf-msg bf-msg-assistant';
      el.innerHTML = `<div class="bf-bubble bf-typing"><span></span><span></span><span></span></div>`;
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
    } else if (el) {
      el.remove();
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Replay any existing history into the DOM on load
  state.messages.forEach(m => renderMessage(m.role, m.content));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.loading) return;
    input.value = '';
    pushMessage('user', text);

    state.loading = true;
    renderTyping(true);

    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: state.messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Request failed');
      }

      const data = await resp.json();
      renderTyping(false);
      state.messages.push({ role: 'assistant', content: data.message });
      saveHistory();
      renderMessage('assistant', data.message, data.products);
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      renderTyping(false);
      renderMessage('assistant', "Sorry, I couldn't reach the assistant just now. Please try again in a moment.");
    } finally {
      state.loading = false;
    }
  });
})();
