import { GoogleGenAI } from '@google/genai';
import type { Message } from './types.js';

function isGeminiOn(): boolean {
  const value = (process.env.GEMINI_ON ?? 'off').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

async function callVertexGemini(
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI');

  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-flash';

  console.log(`[LLM] Calling Vertex AI ${model}...`);

  const ai = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });

  const response = await ai.models.generateContent({
    model,
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.2,
      responseMimeType: "application/json",

    },
  });

  const text = response.text?.trim() ?? '';

  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function callLLM(
  systemPrompt: string,
  messages: Message[] | string,
): Promise<string> {
  const msgArray: Message[] = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  if (isGeminiOn()) {
    try {
      return await callVertexGemini(systemPrompt, msgArray);
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      if (status === 429) {
        console.log('[LLM] Vertex rate limited, waiting 15s...');
        await new Promise((r) => setTimeout(r, 15000));
        return callLLM(systemPrompt, messages);
      }
      throw err;
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY');

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const model = process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3-nano-30b-a3b:free';

  console.log(`[LLM] Calling ${model}...`);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_APP_NAME ?? 'phd-agent',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...msgArray,
      ],
      temperature: 0.2,
    }),
  });

  const raw = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON from API: ${raw.slice(0, 200)}`);
  }

  if (!response.ok) {
    const msg = payload?.error?.message ?? raw;
    if (response.status === 429) {
      console.log(`[LLM] Rate limited, waiting 15s...`);
      await new Promise(r => setTimeout(r, 15000));
      return callLLM(systemPrompt, messages);
    }
    throw new Error(`[OpenRouter API Error ${response.status}] ${msg}`);
  }

  const content = payload?.choices?.[0]?.message?.content ?? '';

  // Strip thinking tags if model uses them
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}