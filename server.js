/**
 * Beyond Food — AI Nutrition Expert backend
 * ------------------------------------------------------------
 * This server is the ONLY place your OpenAI API key ever lives.
 * The browser never talks to OpenAI directly — it talks to this
 * server, and this server talks to OpenAI. Never move the API
 * key into frontend code.
 *
 * Endpoints:
 *   POST /api/chat        Conversational assistant (used by the chat widget)
 *   POST /api/recommend   One-shot structured quiz -> product recommendations
 * ------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const products = require('./products.json');

const app = express();
   app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// Lock this down to your real domain(s) in production.
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
}));

// Basic abuse/cost protection. Tune to your traffic.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 requests/minute/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment and try again.' },
});

const openai = new OpenAI({
     apiKey: process.env.OPENAI_API_KEY,
     timeout: 30000,
     maxRetries: 3,
     fetch: (...args) => fetch(...args),
   });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

app.use(express.static('public'));
// ---------------------------------------------------------------
// Product search — this is the "tool" the model can call so it
// recommends real SKUs instead of making products up.
// ---------------------------------------------------------------
async function searchProducts({ goal, category, max_results = 3 }) {
  const tagFilter = goal ? `tag:'goal:${goal}'` : '';
  const productTypeFilter = category ? `product_type:'${category}'` : '';
  const query = [tagFilter, productTypeFilter].filter(Boolean).join(' AND ');

  const resp = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({
        query: `
          query($q: String!, $first: Int!) {
            products(query: $q, first: $first) {
              edges {
                node {
                  title
                  handle
                  description
                  priceRange { minVariantPrice { amount } }
                  featuredImage { url }
                  tags
                }
              }
            }
          }
        `,
        variables: { q: query, first: max_results },
      }),
    }
  );

  const data = await resp.json();
  return data.data.products.edges.map(({ node }) => ({
    id: node.handle,
    name: node.title,
    price: Number(node.priceRange.minVariantPrice.amount),
    size: '',
    tags: node.tags,
    protein_g: 0,
    description: node.description.slice(0, 140),
    url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${node.handle}`,
    image: node.featuredImage?.url || '',
  }));
}

const searchProductsTool = {
  type: 'function',
  function: {
    name: 'search_products',
    description: 'Search the Beyond Food product catalog to recommend real, in-stock products that match the customer\'s goals, diet, and preferences. Always call this before recommending a specific product — never invent product names.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          enum: ['weight-loss', 'muscle-gain', 'marathon-prep', 'hyrox-prep', 'general-fitness'],
          description: 'The customer\'s primary fitness/nutrition goal.',
        },
        diet: {
          type: 'string',
          enum: ['vegetarian', 'vegan', 'eggetarian', 'non-vegetarian'],
          description: 'Dietary preference to filter by, if known.',
        },
        category: {
          type: 'string',
          enum: ['bars', 'cookies', 'shakes', 'granola', 'snacks'],
          description: 'Product category, if the customer asked for a specific type.',
        },
        high_protein: {
          type: 'boolean',
          description: 'True if protein content should be prioritized.',
        },
        exclude_allergens: {
          type: 'array',
          items: { type: 'string', enum: ['nuts', 'dairy', 'gluten', 'soy'] },
          description: 'Allergens/ingredients to avoid.',
        },
        max_results: { type: 'integer', description: 'How many products to return (default 3).' },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the Beyond Food AI Nutrition Expert, embedded on the Beyond Food website.

Beyond Food makes clean, whole-food nutrition products (protein bars, cookies, meal-replacement shakes, granola, snacks) built around a "4 Hour Nutrition" philosophy — sustained energy without sugar crashes.

You are a genuinely knowledgeable nutrition assistant, not just a product-matcher. You can:
- Discuss nutrition, training, and diet topics freely and in depth, the way a well-informed nutrition coach would — meal plans, macro guidance, general eating strategies, how to structure meals around workouts, etc.
- Help people think through their goals conversationally, asking follow-up questions when it genuinely helps.
- Naturally suggest where Beyond Food products could fit into a plan you've discussed (e.g. "a Beyond Food protein bar would work well as your pre-workout snack here") — call the search_products function whenever you're about to name or recommend a specific product, so the recommendation is always a real, in-stock item. Never invent product names, prices, or claims that aren't in the catalog data returned to you.
- If search_products comes back empty for what someone asked, don't just say "not available" and stop — still give them useful general guidance on that topic, and mention that specific product isn't in the catalog yet, offering to suggest something from a related category instead.
- If someone asks something entirely general (e.g. "suggest a meal plan" or "how much protein do I need"), answer it properly and helpfully first — you don't need to force a product recommendation into every single reply.

Guardrails:
- If a question is about diagnosing health conditions, medication interactions, or anything requiring individualized medical advice, say so plainly and suggest they consult a doctor or dietitian — don't diagnose.
- Stay evidence-based and avoid extreme or fad claims.

Tone: warm, knowledgeable, conversational — like a helpful coach, not a sales script. Reply length should match the question: quick questions get quick answers, meal-plan or "explain this" questions can be longer and more detailed.`;

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    if (messages.length > 30) {
      return res.status(400).json({ error: 'conversation too long for this endpoint' });
    }

    const conversation = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    let completion = await openai.chat.completions.create({
      model: MODEL,
      messages: conversation,
      tools: [searchProductsTool],
      temperature: 0.6,
      max_tokens: 400,
    });

    let reply = completion.choices[0].message;
    let productResults = [];

    // Handle the model calling search_products (possibly more than once)
    let loopGuard = 0;
    while (reply.tool_calls && reply.tool_calls.length && loopGuard < 3) {
      conversation.push(reply);

      for (const toolCall of reply.tool_calls) {
        if (toolCall.function.name === 'search_products') {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const found = await searchProducts(args);
          productResults = found; // surfaced to the frontend for rendering cards

          conversation.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(found.map(p => ({
              id: p.id, name: p.name, price: p.price, size: p.size,
              tags: p.tags, protein_g: p.protein_g, description: p.description,
            }))),
          });
        }
      }

      completion = await openai.chat.completions.create({
        model: MODEL,
        messages: conversation,
        tools: [searchProductsTool],
        temperature: 0.6,
        max_tokens: 400,
      });
      reply = completion.choices[0].message;
      loopGuard++;
    }

    res.json({
      message: reply.content,
      products: productResults.map(p => ({
        id: p.id, name: p.name, price: p.price, size: p.size,
        tags: p.tags, description: p.description, url: p.url, image: p.image,
      })),
    });
  } catch (err) {
    console.error('chat error:', err);
    res.status(500).json({ error: 'Something went wrong talking to the assistant. Please try again.' });
  }
});

// ---------------------------------------------------------------
// Structured quiz -> recommendations (mirrors the "Tell us about
// you" -> "Your Personalized Recommendations" flow).
// Matching is deterministic (fast, predictable, no hallucination risk);
// GPT is only used to write the short human rationale.
// ---------------------------------------------------------------
app.post('/api/recommend', chatLimiter, async (req, res) => {
  try {
    const { goal, diet, allergies = [], nutritionFocus, ingredientsLove = [], ingredientsAvoid = [] } = req.body;

    let matches = products;
    if (goal) matches = matches.filter(p => p.goals.includes(goal));
    if (diet) matches = matches.filter(p => p.diet.includes(diet));
    if (allergies.length) matches = matches.filter(p => !p.allergens.some(a => allergies.includes(a)));
    if (ingredientsAvoid.length) {
      matches = matches.filter(p => !ingredientsAvoid.some(bad =>
        p.description.toLowerCase().includes(bad.toLowerCase())));
    }
    if (nutritionFocus === 'High Protein') {
      matches = [...matches].sort((a, b) => b.protein_g - a.protein_g);
    }

    matches = matches.slice(0, 4);

    let rationale = [];
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You write 3-4 short bullet points (max 10 words each) explaining why a set of products was recommended, based on the customer profile given. Return ONLY a JSON array of strings, nothing else.' },
          { role: 'user', content: JSON.stringify({ goal, diet, allergies, nutritionFocus, ingredientsLove, ingredientsAvoid, products: matches.map(p => p.name) }) },
        ],
        temperature: 0.4,
        max_tokens: 150,
      });
      rationale = JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      // Fall back to a generic rationale if the model output isn't clean JSON
      rationale = [
        goal ? `Matches your goal: ${goal.replace('-', ' ')}` : null,
        nutritionFocus ? `Prioritizes ${nutritionFocus}` : null,
        diet ? `Fits a ${diet} diet` : null,
        allergies.length ? `Avoids: ${allergies.join(', ')}` : null,
      ].filter(Boolean);
    }

    res.json({
      products: matches.map(p => ({
        id: p.id, name: p.name, price: p.price, size: p.size,
        tags: p.tags, description: p.description, url: p.url, image: p.image,
      })),
      rationale,
    });
  } catch (err) {
    console.error('recommend error:', err);
    res.status(500).json({ error: 'Could not generate recommendations. Please try again.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Beyond Food AI backend running on port ${PORT}`));
