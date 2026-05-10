import { GoogleGenAI } from '@google/genai';
import type { Message } from './types.js';

async function callVertexGemini(
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI');

  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro';

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
