export const config = { runtime: 'edge' };

// Persona: meniru gaya percakapan Fable 5 (Claude) — hangat, cerdas, langsung ke inti.
const SYSTEM_PROMPT = `You are Wly, a highly capable AI assistant. Your conversational style is modeled after Anthropic's most advanced Claude model: warm, intellectually curious, and direct.

Behavioral rules:
- Lead with the answer. Give the conclusion first, then supporting detail only if it helps.
- Match the user's language. If they write in Indonesian, reply in natural Indonesian. If they mix languages, mirror them.
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
  openrouter: {
    key: () => process.env.OPENROUTER_API_KEY,
    model: () => process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },
};

// Urutan fallback kalau client tidak memilih provider.
const AUTO_ORDER = ['groq', 'gemini', 'openrouter'];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pickProvider(requested) {
  if (requested && requested !== 'auto') {
    const p = PROVIDERS[requested];
    if (!p) return { error: `Provider tidak dikenal: ${requested}` };
    if (!p.key()) return { error: `API key untuk ${requested} belum diset di environment variable Vercel.` };
    return { name: requested };
  }
  for (const name of AUTO_ORDER) {
    if (PROVIDERS[name].key()) return { name };
  }
  return {
    error:
      'Tidak ada API key yang terpasang. Set minimal satu dari GROQ_API_KEY, GEMINI_API_KEY, atau OPENROUTER_API_KEY di Vercel (Settings > Environment Variables).',
  };
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
  // Batasi konteks: 40 pesan terakhir.
  return clean.slice(-40);
}

// Ubah SSE gaya OpenAI (Groq/OpenRouter) menjadi stream teks polos.
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
            // potongan JSON belum lengkap; abaikan
          }
        }
      },
    })
  );
}

// Ubah SSE Gemini (alt=sse) menjadi stream teks polos.
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
            // potongan JSON belum lengkap; abaikan
          }
        }
      },
    })
  );
}

async function callOpenAiCompatible(url, apiKey, model, messages, extraHeaders = {}) {
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

async function callGemini(apiKey, model, messages) {
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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Gunakan method POST.' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Body harus JSON valid.' }, 400);
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) {
    return jsonResponse({ error: 'Field "messages" wajib berisi minimal satu pesan.' }, 400);
  }

  const picked = pickProvider(body.provider);
  if (picked.error) return jsonResponse({ error: picked.error }, 400);

  const provider = picked.name;
  const apiKey = PROVIDERS[provider].key();
  const model = PROVIDERS[provider].model();

  let upstream;
  try {
    if (provider === 'groq') {
      upstream = await callOpenAiCompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        apiKey,
        model,
        messages
      );
    } else if (provider === 'openrouter') {
      upstream = await callOpenAiCompatible(
        'https://openrouter.ai/api/v1/chat/completions',
        apiKey,
        model,
        messages,
        {
          'HTTP-Referer': req.headers.get('origin') || 'https://wlybot.vercel.app',
          'X-Title': 'Wlybot',
        }
      );
    } else {
      upstream = await callGemini(apiKey, model, messages);
    }
  } catch (err) {
    return jsonResponse({ error: `Gagal menghubungi ${provider}: ${err.message}` }, 502);
  }

  if (!upstream.ok) {
    let detail = '';
    try {
      detail = (await upstream.text()).slice(0, 500);
    } catch {
      // abaikan
    }
    return jsonResponse(
      { error: `${provider} mengembalikan status ${upstream.status}. ${detail}` },
      502
    );
  }

  const textStream =
    provider === 'gemini' ? geminiSseToText(upstream.body) : openAiSseToText(upstream.body);

  return new Response(textStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Provider': provider,
      'X-Model': model,
    },
  });
}
