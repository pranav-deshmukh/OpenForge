import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import type { Message } from './types.js';

function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.code;
  const message = String(err?.message ?? '');
  return status === 429 || message.includes('RESOURCE_EXHAUSTED');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getAI(): GoogleGenAI {
  const provider = process.env.AI_PROVIDER || 'vertex';
  if (provider === 'vertex') {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI');
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
    return new GoogleGenAI({ vertexai: true, project, location });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  return new GoogleGenAI({ apiKey });
}

function getModel(): string {
  return process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-flash';
}

async function generateWithGemini(
  systemPrompt: string,
  messages: Message[],
  responseMimeType: 'application/json' | 'text/plain' = 'application/json'
): Promise<string> {
  const ai = getAI();
  const model = getModel();

  console.log('[LLM] Calling ' + model + '...');
  const result = await ai.models.generateContent({
    model,
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.1,
      responseMimeType,
    },
  });

  let text = '';
  if (typeof (result as any).text === 'string') {
    text = (result as any).text;
  } else if ((result as any).response && typeof (result as any).response.text === 'function') {
    text = await (result as any).response.text();
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
    console.error('[LLM] Error:', err.message || err);
    if (isRateLimitError(err)) {
      console.log('[LLM] Rate limited, waiting 15s...');
      await sleep(15000);
      return callLLM(systemPrompt, messages, responseMimeType);
    }
    throw err;
  }
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface LLMToolResponse {
  thought: string;
  toolCalls: ToolCall[];
  rawText: string;
}

// Native Gemini content for multi-turn tool calling
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, any> } }
  | { functionResponse: { name: string; response: { result: string } } };

/**
 * Native multi-turn function calling with Gemini.
 * Uses proper functionCall/functionResponse parts for structured tool protocol.
 * Supports parallel tool calls.
 */
export async function callLLMWithTools(
  systemPrompt: string,
  messages: GeminiContent[],
  tools: ToolDefinition[],
  modelOverride?: string
): Promise<LLMToolResponse> {
  return callLLMWithToolsAttempt(systemPrompt, messages, tools, 1, modelOverride);
}

async function callLLMWithToolsAttempt(
  systemPrompt: string,
  messages: GeminiContent[],
  tools: ToolDefinition[],
  attempt: number,
  modelOverride?: string,
): Promise<LLMToolResponse> {
  const ai = getAI();
  const model = modelOverride || getModel();

  const geminiTools = [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];

  console.log('[LLM] ' + model + ' + ' + tools.length + ' tools (step ' + attempt + ')');

  try {
    const result = await ai.models.generateContent({
      model,
      contents: messages,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.1,
        tools: geminiTools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        },
      },
    });

    let thought = '';
    const toolCalls: ToolCall[] = [];

    // Extract from top-level
    if (result.text) {
      thought = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    // Extract all parallel function calls
    if (result.functionCalls && result.functionCalls.length > 0) {
      for (const fc of result.functionCalls) {
        if (fc.name) {
          toolCalls.push({ name: fc.name, args: fc.args ?? {} });
        }
      }
    }

    // Also check candidate parts for mixed responses
    if (toolCalls.length === 0) {
      const parts = result.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if ((part as any).text) {
          thought += (thought ? '\n' : '') + (part as any).text;
        }
        if ((part as any).functionCall?.name) {
          toolCalls.push({
            name: (part as any).functionCall.name,
            args: (part as any).functionCall.args ?? {},
          });
        }
      }
      thought = thought.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    // Fallback: parse JSON from text
    if (toolCalls.length === 0 && thought) {
      const parsed = tryParseToolFromText(thought);
      if (parsed) toolCalls.push(parsed);
    }

    return { thought, toolCalls, rawText: thought };
  } catch (err: any) {
    console.error('[LLM] Error attempt ' + attempt + ':', err.message || err);
    if (isRateLimitError(err) && attempt < 4) {
      const delayMs = 5000 * attempt;
      console.log('[LLM] Rate limited, waiting ' + delayMs + 'ms...');
      await sleep(delayMs);
      return callLLMWithToolsAttempt(systemPrompt, messages, tools, attempt + 1, modelOverride);
    }
    throw err;
  }
}

function tryParseToolFromText(text: string): ToolCall | null {
  try {
    const cleaned = text.replace(/\\\json\n?/g, '').replace(/\\\\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.command && parsed.command !== '' && parsed.command !== 'ask_user') {
      return { name: 'run_shell', args: { command: parsed.command } };
    } else if (parsed.str_replace) {
      return { name: 'str_replace_file', args: parsed.str_replace };
    } else if (parsed.done) {
      return { name: 'task_done', args: { summary: parsed.summary ?? '' } };
    }
  } catch {}
  return null;
}
