import { GoogleGenAI } from '@google/genai';
import type { Message } from './types.js';

async function generateWithGemini(
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  const provider = process.env.AI_PROVIDER || 'vertex'; // 'vertex' or 'google'
  const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-1.5-pro';

  let ai: GoogleGenAI;

  if (provider === 'vertex') {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI');

    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
    console.log(`[LLM] Calling Vertex AI ${model}...`);

    ai = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY for Google GenAI');
    
    console.log(`[LLM] Calling Google GenAI ${model}...`);
    ai = new GoogleGenAI({
      apiKey
    });
  }

  console.log(`[LLM] Request sent to ${model}. Waiting for response...`);
  const result = await ai.models.generateContent({
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

  console.log(`[LLM] Response received from ${model}`);
  
  // For @google/genai, the text might be in result.text or result.response.text()
  // Let's try to be robust.
  let text = '';
  if (typeof (result as any).text === 'string') {
    text = (result as any).text;
  } else if ((result as any).response && typeof (result as any).response.text === 'function') {
    text = await (result as any).response.text();
  } else {
    console.error('[LLM] Unexpected response structure:', JSON.stringify(result, null, 2));
  }

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
    return await generateWithGemini(systemPrompt, msgArray);
  } catch (err: any) {
    console.error(`[LLM] Error calling Gemini:`, err.message || err);
    const status = err?.status ?? err?.code;
    if (status === 429) {
      console.log('[LLM] API rate limited, waiting 15s...');
      await new Promise((r) => setTimeout(r, 15000));
      return callLLM(systemPrompt, messages);
    }
    throw err;
  }
}
