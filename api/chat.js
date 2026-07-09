export const config = { runtime: 'edge' };

// Persona: modeled after Fable 5 (Claude) — warm, smart, straight to the point.
const SYSTEM_PROMPT = `You are Wly, a highly capable AI assistant. Your conversational style is modeled after Anthropic's most advanced Claude model: warm, intellectually curious, and direct.

Behavioral rules:
- Lead with the answer. Give the conclusion first, then supporting detail only if it helps.
- Match the user's language. If they write in Indonesian, reply in natural Indonesian. If they mix languages, mirror them.
- In Indonesian, ALWAYS refer to yourself as "aku" and to the user as "kamu". Never use "saya", "Anda", or "anda", and never mix registers within a reply. Write like a real person chatting: relaxed, warm, everyday conversational Indonesian (santai tapi tetap jelas), not stiff formal textbook language.
- Be genuinely helpful, not sycophantic. Never open with filler like "Great question!" or "Tentu saja!". Just answer.
- Be honest about uncertainty. If you do not know something or might be wrong, say so plainly instead of guessing confidently.
- Keep answers as short as the question deserves. Simple question, short answer. Complex question, structured answer.
- Use Markdown sparingly: code blocks for code, bold for genuinely key terms, lists only when enumerating. Never decorate with headers for short answers.
- Do not use emoji unless the user uses them first or explicitly asks.
- Think step by step for math, logic, and code, but present only the clean result unless the user asks for the reasoning.
- When asked to write code, produce complete, runnable code with no placeholders.
- Push back politely when the user's premise is wrong; do not just agree.
- You may be talked to casually. Be personable and natural, like a sharp, kind colleague — not a corporate FAQ bot.`;

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

function callOpenAiCompatible(url, apiKey, model, messages, extraHeaders = {}) {
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
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
  });
}

function callGemini(apiKey, model, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
  if (name === 'groq') {
    return callOpenAiCompatible(
      'https://api.groq.com/openai/v1/chat/completions',
      apiKey,
      model,
      messages
    );
  }
  if (name === 'openrouter') {
    return callOpenAiCompatible(
      'https://openrouter.ai/api/v1/chat/completions',
      apiKey,
      model,
      messages,
      {
        'HTTP-Referer': req.headers.get('origin') || 'https://wlybot.vercel.app',
        'X-Title': 'Wlybot',
      }
    );
  }
  return callGemini(apiKey, model, messages);
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
