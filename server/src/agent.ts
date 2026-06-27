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

async function generateWithGemini(
  systemPrompt: string,
  messages: Message[],
  responseMimeType: 'application/json' | 'text/plain' = 'application/json'
): Promise<string> {
  const provider = process.env.AI_PROVIDER || 'vertex';
  const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro';

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
      apiKey,
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
    console.error('[LLM] Error calling Gemini:', err.message || err);
    if (isRateLimitError(err)) {
      console.log('[LLM] API rate limited, waiting 15s...');
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
  toolCall: ToolCall | null;
  rawText: string;
}

export async function callLLMWithTools(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[]
): Promise<LLMToolResponse> {
  return callLLMWithToolsAttempt(systemPrompt, messages, tools, 1);
}

async function callLLMWithToolsAttempt(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
  attempt: number,
): Promise<LLMToolResponse> {
  const provider = process.env.AI_PROVIDER || 'vertex';
  const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro';

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
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];

  console.log(`[LLM] Calling ${model} with ${tools.length} tools...`);

  try {
    const result = await ai.models.generateContent({
      model,
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.2,
        tools: geminiTools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
          },
        },
      },
    });

    let thought = result.text?.replace(/<think>[\s\S]*?<\/think>/g, '').trim() ?? '';
    let toolCall: ToolCall | null = null;

    const directFunctionCall = result.functionCalls?.[0];
    if (directFunctionCall?.name) {
      toolCall = {
        name: directFunctionCall.name,
        args: directFunctionCall.args ?? {},
      };
    }

    if (!toolCall) {
      const parts = result.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          thought += part.text;
        }
        if (part.functionCall?.name) {
          toolCall = {
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          };
        }
      }
    }

    if (!toolCall && thought) {
      try {
        const cleaned = thought
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.command && parsed.command !== '' && parsed.command !== 'ask_user') {
          toolCall = { name: 'run_shell', args: { command: parsed.command } };
          thought = parsed.thought ?? thought;
        } else if (parsed.str_replace) {
          toolCall = { name: 'str_replace_file', args: parsed.str_replace };
          thought = parsed.thought ?? thought;
        } else if (parsed.delete_block) {
          toolCall = { name: 'delete_block_file', args: parsed.delete_block };
          thought = parsed.thought ?? thought;
        } else if (parsed.insert_at_line) {
          toolCall = { name: 'insert_at_line', args: parsed.insert_at_line };
          thought = parsed.thought ?? thought;
        } else if (parsed.read_file) {
          toolCall = { name: 'read_file', args: { path: parsed.read_file } };
          thought = parsed.thought ?? thought;
        } else if (parsed.done) {
          toolCall = {
            name: 'task_done',
            args: { summary: parsed.summary ?? '', artifacts: parsed.artifacts ?? [] },
          };
          thought = parsed.thought ?? thought;
        } else if (parsed.command === 'ask_user') {
          toolCall = { name: 'ask_user', args: { question: parsed.thought ?? '' } };
          thought = parsed.thought ?? thought;
        }
      } catch {
        // Not JSON, keep thought-only response.
      }
    }

    return { thought, toolCall, rawText: thought };
  } catch (err: any) {
    console.error(`[LLM] Tool call error on attempt ${attempt}:`, err.message || err);
    if (isRateLimitError(err) && attempt < 4) {
      const delayMs = 5000 * attempt;
      console.log(`[LLM] Tool call rate limited, waiting ${delayMs}ms before retry...`);
      await sleep(delayMs);
      return callLLMWithToolsAttempt(systemPrompt, messages, tools, attempt + 1);
    }
    throw err;
  }
}
