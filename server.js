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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

app.use(express.static('public'));
// ---------------------------------------------------------------
// Product search — this is the "tool" the model can call so it
// recommends real SKUs instead of making products up.
// ---------------------------------------------------------------
function searchProducts({ goal, diet, high_protein, exclude_allergens = [], category, max_results = 3 }) {
  let results = products;

  if (goal) {
    results = results.filter(p => p.goals.includes(goal));
  }
  if (diet) {
    results = results.filter(p => p.diet.includes(diet));
  }
  if (category) {
    results = results.filter(p => p.category === category);
  }
  if (exclude_allergens && exclude_allergens.length) {
    results = results.filter(p => !p.allergens.some(a => exclude_allergens.includes(a)));
  }
  if (high_protein) {
    results = [...results].sort((a, b) => b.protein_g - a.protein_g);
  }

  return results.slice(0, max_results);
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

Your job:
1. Have a short, warm, efficient conversation to understand the visitor's goal (e.g. weight loss, muscle gain, marathon/Hyrox prep, general fitness), dietary preference, allergies/ingredients to avoid, and what matters most to them (protein, fiber, low sugar, etc.). Don't interrogate — ask at most 1-2 clarifying questions at a time.
2. Once you have enough to go on, call the search_products function to find real matching products. Never invent product names, prices, or claims that aren't in the catalog data returned to you.
3. Recommend 1-3 products, explain briefly WHY each fits their goals, and let the frontend render the product cards (you don't need to repeat prices/images in text — just talk about fit).
4. If a question is about health conditions, medication interactions, or anything beyond general nutrition guidance, say so plainly and suggest they consult a doctor or dietitian — don't diagnose or give medical advice.
5. Keep replies concise (2-4 sentences plus the product call when relevant). Friendly, knowledgeable, never pushy.`;

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
          const found = searchProducts(args);
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
