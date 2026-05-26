import { GoogleGenAI } from '@google/genai';
import type { Message } from './types.js';

async function generateWithGemini(
  systemPrompt: string,
  messages: Message[],
  responseMimeType: 'application/json' | 'text/plain' = 'application/json'
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
      responseMimeType,
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
  responseMimeType: 'application/json' | 'text/plain' = 'application/json'
): Promise<string> {
  const msgArray: Message[] = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  try {
    return await generateWithGemini(systemPrompt, msgArray, responseMimeType);
  } catch (err: any) {
    console.error(`[LLM] Error calling Gemini:`, err.message || err);
    const status = err?.status ?? err?.code;
    if (status === 429) {
      console.log('[LLM] API rate limited, waiting 15s...');
      await new Promise((r) => setTimeout(r, 15000));
      return callLLM(systemPrompt, messages, responseMimeType);
    }
    throw err;
  }
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema object
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface LLMToolResponse {
  thought: string;
  toolCall: ToolCall | null;
  rawText: string;
}

export async function callLLMWithTools(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[]
): Promise<LLMToolResponse> {
  const provider = process.env.AI_PROVIDER || 'vertex';
  const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-1.5-pro';

  let ai: GoogleGenAI;

  if (provider === 'vertex') {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI');
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
    ai = new GoogleGenAI({ vertexai: true, project, location });
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
    ai = new GoogleGenAI({ apiKey });
  }

  const geminiTools = [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }];

  console.log(`[LLM] Calling ${model} with ${tools.length} tools...`);

  const result = await (ai.models as any).generateContent({
    model,
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    tools: geminiTools,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.2,
    },
  });

  // Extract thought text and function call from response
  const candidates = result?.candidates ?? result?.response?.candidates ?? [];
  const parts = candidates?.[0]?.content?.parts ?? [];

  let thought = '';
  let toolCall: ToolCall | null = null;

  for (const part of parts) {
    if (part.text) {
      thought += part.text;
    }
    if (part.functionCall) {
      toolCall = {
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      };
    }
  }

  // Fallback: if model returned plain text JSON (some Gemini versions do this)
  if (!toolCall && thought) {
    try {
      const cleaned = thought
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      // If it looks like a tool call in old format, convert it
      if (parsed.command && parsed.command !== '' && parsed.command !== 'ask_user') {
        toolCall = { name: 'run_shell', args: { command: parsed.command } };
        thought = parsed.thought ?? thought;
      } else if (parsed.str_replace) {
        toolCall = { name: 'str_replace_file', args: parsed.str_replace };
        thought = parsed.thought ?? thought;
      } else if (parsed.read_file) {
        toolCall = { name: 'read_file', args: { path: parsed.read_file } };
        thought = parsed.thought ?? thought;
      } else if (parsed.done) {
        toolCall = { name: 'task_done', args: { summary: parsed.summary ?? '', artifacts: parsed.artifacts ?? [] } };
        thought = parsed.thought ?? thought;
      } else if (parsed.command === 'ask_user') {
        toolCall = { name: 'ask_user', args: { question: parsed.thought ?? '' } };
        thought = parsed.thought ?? thought;
      }
    } catch {
      // Not JSON, that's fine — thought text only
    }
  }

  return { thought, toolCall, rawText: thought };
}
