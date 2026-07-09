export const config = { runtime: 'edge' };

// Persona is separate from the rules so it can be swapped via the
// SYSTEM_PERSONA env var without touching any behavior below.
const PERSONA =
  process.env.SYSTEM_PERSONA ||
  `You are Wly, a sharp, warm, and genuinely capable AI assistant. You talk like a smart, kind colleague — personable and natural, never like a corporate FAQ bot. Be genuinely helpful, not sycophantic.`;

const RULES = `Language (absolute rule, re-check on EVERY message): always reply in the language of the user's most recent message. Indonesian in, Indonesian out; English in, English out. If the user switches language mid-conversation, switch immediately — the latest message always wins over earlier ones. Never mix languages in one reply unless the user does. Code, code comments inside code blocks, and technical identifiers stay as-is, but all explanation around them follows the user's language.

Tone and register: mirror the user. If they write casually, be relaxed and conversational; if they write formally, be polite and measured. In Indonesian, choose pronouns and register that match how the user talks and keep them consistent within a reply — write like a real person chatting, not a textbook.

Honesty and knowledge limits:
- You have NO internet access and your knowledge has a training cutoff. For current news, prices, exchange rates, weather, schedules, or anything likely to have changed, say plainly that you cannot verify it and suggest where the user can check. Never invent numbers, links, citations, or names.
- If you are unsure, say so. A short honest "I don't know" beats a confident guess.
- Push back politely when the user's premise is wrong; do not just agree.

Answer style (this is a mobile-first chat UI):
- Lead with the answer. Conclusion first, supporting detail only if it helps.
- Default to concise: at most ~3 short paragraphs unless the user asks for depth. Simple question, short answer; complex question, structured answer.
- Use Markdown sparingly: lists only when enumerating, bold only for genuinely key terms, never headers on short answers.
- Always name the language on code fences (e.g. \`\`\`python, \`\`\`js). Produce complete, runnable code with no placeholders.
- No emoji unless the user uses them first or asks.
- Never open with filler like "Great question!" or "Tentu!". Just answer.

Reasoning: think step by step for math, logic, and code, but present only the clean result unless the user asks for the reasoning.

Refusals: if you cannot do something, say so in one or two sentences, offer the closest thing you CAN do, and skip the lecture.

Examples of the expected style:

User: "cara center div gimana sih"
Assistant: "Paling gampang pakai flexbox di parent-nya:

\`\`\`css
.parent {
  display: flex;
  justify-content: center;
  align-items: center;
}
\`\`\`

Itu bikin isinya ke tengah secara horizontal dan vertikal. Kalau cuma butuh horizontal, \`margin: 0 auto\` di div-nya juga cukup."

User: "what's the capital of australia?"
Assistant: "Canberra — not Sydney. Sydney is the biggest city, but the capital has been Canberra since 1913."`;

// Small per-provider reinforcements: Llama-family models (Groq/OpenRouter)
// tend to drift into English and over-explain, so they get an extra nudge.
const PROVIDER_NOTES = {
  groq: 'Reminder: re-read the language rule before every reply, and keep answers tight — no padding, no restating the question.',
  openrouter: 'Reminder: re-read the language rule before every reply, and keep answers tight — no padding, no restating the question.',
  gemini: '',
};

function buildSystemPrompt(provider) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  });
  const note = PROVIDER_NOTES[provider];
  return (
    `${PERSONA}\n\nToday's date is ${today} (Asia/Jakarta).\n\n${RULES}` +
    (note ? `\n\n${note}` : '')
  );
}

const PROVIDERS = {
  groq: {
    key: () => process.env.GROQ_API_KEY,
    model: () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  openrouter: {
    key: () => process.env.OPENROUTER_API_KEY,
    model: () => process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },
};

// Groq is primary; Gemini then OpenRouter act as automatic fallbacks
// when the previous provider fails (rate limit, invalid key, outage).
const FALLBACK_ORDER = ['groq', 'gemini', 'openrouter'];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const clean = messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 32000) }));
  // Limit context to the last 40 messages.
  return clean.slice(-40);
}

// Convert OpenAI-style SSE (Groq/OpenRouter) into a plain text stream.
function openAiSseToText(upstreamBody) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return upstreamBody.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const text = JSON.parse(data).choices?.[0]?.delta?.content;
            if (text) controller.enqueue(encoder.encode(text));
          } catch {
            // incomplete JSON fragment; ignore
          }
        }
      },
    })
  );
}

// Convert Gemini SSE (alt=sse) into a plain text stream.
function geminiSseToText(upstreamBody) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return upstreamBody.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(trimmed.slice(5).trim());
            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.text) controller.enqueue(encoder.encode(part.text));
            }
          } catch {
            // incomplete JSON fragment; ignore
          }
        }
      },
    })
  );
}

function callOpenAiCompatible(url, apiKey, model, messages, systemPrompt, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.7,
      max_tokens: 4096,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
}

function callGemini(apiKey, model, messages, systemPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    }),
  });
}

function callProvider(name, messages, req) {
  const apiKey = PROVIDERS[name].key();
  const model = PROVIDERS[name].model();
  const systemPrompt = buildSystemPrompt(name);
  if (name === 'groq') {
    return callOpenAiCompatible(
      'https://api.groq.com/openai/v1/chat/completions',
      apiKey,
      model,
      messages,
      systemPrompt
    );
  }
  if (name === 'openrouter') {
    return callOpenAiCompatible(
      'https://openrouter.ai/api/v1/chat/completions',
      apiKey,
      model,
      messages,
      systemPrompt,
      {
        'HTTP-Referer': req.headers.get('origin') || 'https://wlybot.vercel.app',
        'X-Title': 'Wlybot',
      }
    );
  }
  return callGemini(apiKey, model, messages, systemPrompt);
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Use the POST method.' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400);
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) {
    return jsonResponse({ error: '"messages" must contain at least one message.' }, 400);
  }

  // Pick candidate providers. Auto mode tries them in order
  // (Groq -> Gemini -> OpenRouter); a manual choice tries only one.
  const requested = body.provider;
  let candidates;
  if (requested && requested !== 'auto') {
    if (!PROVIDERS[requested]) {
      return jsonResponse({ error: `Unknown provider: ${requested}` }, 400);
    }
    if (!PROVIDERS[requested].key()) {
      return jsonResponse(
        { error: `The API key for ${requested} is not set in Vercel environment variables.` },
        400
      );
    }
    candidates = [requested];
  } else {
    candidates = FALLBACK_ORDER.filter((name) => PROVIDERS[name].key());
    if (candidates.length === 0) {
      return jsonResponse(
        {
          error:
            'No API keys configured. Set at least one of GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY in Vercel (Settings > Environment Variables).',
        },
        400
      );
    }
  }

  const failures = [];
  for (const provider of candidates) {
    let upstream;
    try {
      upstream = await callProvider(provider, messages, req);
    } catch (err) {
      failures.push(`${provider}: ${err.message}`);
      continue;
    }

    if (!upstream.ok) {
      let detail = '';
      try {
        detail = (await upstream.text()).slice(0, 300);
      } catch {
        // ignore
      }
      failures.push(`${provider}: HTTP ${upstream.status} ${detail}`.trim());
      continue;
    }

    const textStream =
      provider === 'gemini' ? geminiSseToText(upstream.body) : openAiSseToText(upstream.body);

    return new Response(textStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Provider': provider,
        'X-Model': PROVIDERS[provider].model(),
      },
    });
  }

  return jsonResponse(
    { error: `All providers failed. Details: ${failures.join(' | ')}` },
    502
  );
}
