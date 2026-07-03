# Beyond Food — AI Nutrition Expert (ChatGPT integration)

A drop-in AI chat widget for your website, backed by the ChatGPT API, that talks to
visitors about their goals and recommends real products from your catalog.

```
beyond-food-ai-chat/
├── server.js          Backend — the only place your OpenAI key lives
├── products.json       Sample product catalog (replace with your real data / DB / Shopify API)
├── package.json
├── .env.example
└── public/
    ├── chat-widget.js   Embeddable widget script
    ├── chat-widget.css  Widget styling (matches your brand colors)
    └── demo.html        Standalone demo page
```

## 1. Why a backend is required

The ChatGPT API key must never be present in code that runs in the browser — anyone
could open dev tools, copy it, and rack up charges on your account. `server.js` is a
small Node/Express server that sits between your website and OpenAI:

```
Browser (chat-widget.js)  →  Your server (server.js)  →  OpenAI ChatGPT API
                                     ↑
                          only place the API key lives
```

## 2. Local setup

```bash
npm install
cp .env.example .env
# edit .env and paste your real OPENAI_API_KEY
npm start
```

Then open `http://localhost:3001/api/demo.html` — wait, the demo page is static, serve
it however you like locally (e.g. `npx serve public`) and point
`window.BEYOND_FOOD_CHAT_API` at `http://localhost:3001/api/chat`.

## 3. Embedding on your real site

Add this near the end of `<body>` on any page (Shopify theme, custom HTML section,
or a `theme.liquid` include):

```html
<script>
  window.BEYOND_FOOD_CHAT_API = "https://your-backend-domain.com/api/chat";
</script>
<link rel="stylesheet" href="https://your-backend-domain.com/chat-widget.css">
<script src="https://your-backend-domain.com/chat-widget.js"></script>
```

**On Shopify specifically:** Shopify themes can't run the Node backend directly, so
host `server.js` separately (see deployment below), then add the snippet above via
Online Store → Themes → Edit Code → `theme.liquid`, or as a Theme App Extension if
you're packaging this as a private app.

## 4. Deploying the backend

Any Node host works — Railway, Render, Fly.io, a small VPS, or AWS/GCP. Steps are the
same everywhere:

1. Push this folder to a git repo.
2. Set the `OPENAI_API_KEY`, `OPENAI_MODEL`, and `ALLOWED_ORIGIN` environment
   variables in your host's dashboard (set `ALLOWED_ORIGIN` to your real storefront
   domain, not `*`, once you're live).
3. Deploy — the host runs `npm install && npm start`.
4. Point `BEYOND_FOOD_CHAT_API` in your site snippet at the deployed URL.

## 5. Connecting your real product catalog

Right now `products.json` is a small hand-written sample matching the products in
your screenshots. For production, replace `searchProducts()` in `server.js` with a
call to your actual product source, e.g. the Shopify Admin/Storefront API:

```js
async function searchProducts({ goal, diet, high_protein, exclude_allergens, category }) {
  // Example: query Shopify's Storefront API, then map the response
  // into the same shape used below so the rest of server.js doesn't change.
}
```

Keep the shape (`id, name, price, size, tags, description, url, image`) consistent
so the widget's product cards keep working without changes.

## 6. Cost & abuse controls already included

- `express-rate-limit` caps each visitor to 20 messages/minute — tune `max` in
  `server.js` to your traffic and budget.
- Conversation length is capped at 30 messages per request.
- `gpt-4o-mini` is set as the default model — it's inexpensive and more than capable
  for product Q&A. Swap `OPENAI_MODEL` if you want a stronger model for more complex
  reasoning.
- Consider adding a monthly spend cap in your OpenAI account dashboard as a backstop.

## 7. The `/api/recommend` endpoint

This mirrors the "Tell us about you" quiz flow from your screenshot: send the
structured quiz answers, get back matched products plus a short AI-written rationale
(the "Why these products?" checklist). Example request:

```js
fetch('https://your-backend-domain.com/api/recommend', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    goal: 'muscle-gain',
    diet: 'vegetarian',
    allergies: [],
    nutritionFocus: 'High Protein',
    ingredientsLove: ['whey-protein'],
    ingredientsAvoid: [],
  }),
}).then(r => r.json()).then(data => {
  console.log(data.products);   // matched product cards
  console.log(data.rationale);  // ["Matches your goal: muscle gain", ...]
});
```

Wire this to the quiz form's "Next: Get My Recommendations" button on your existing
recommendation page.

## 8. Things to review before going live

- **Rate limiting & CORS**: set `ALLOWED_ORIGIN` to your real domain.
- **Logging/monitoring**: add structured logging (e.g. Pino) and alerting for error
  spikes so a bug doesn't burn through your OpenAI budget silently.
- **Medical/health claims**: the system prompt already tells the model to decline
  medical advice and defer to a doctor/dietitian — review and tighten this copy with
  your legal/compliance needs in mind before launch.
- **Persisting conversations**: this demo keeps history in the browser's
  `sessionStorage` only. If you want conversation history/analytics server-side, add
  a database and a session/user id.
