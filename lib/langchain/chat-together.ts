/* eslint-disable no-restricted-syntax */
/* eslint-disable no-underscore-dangle */
/* eslint-disable no-continue */
/* eslint-disable no-await-in-loop */
import {
  BindToolsInput,
  SimpleChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessageFields,
  ChatMessageChunk,
  HumanMessageChunk,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { ToolCallChunk } from '@langchain/core/messages/tool';
import {
  ChatGeneration,
  ChatGenerationChunk,
  ChatResult,
} from '@langchain/core/outputs';
import Together from 'together-ai';
import { CompletionCreateParams } from 'together-ai/resources/chat/completions.mjs';
import { Runnable } from '@langchain/core/runnables';
import {
  BaseFunctionCallOptions,
  BaseLanguageModelInput,
} from '@langchain/core/language_models/base';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import logging from '../logging';

const log = logging('langchain:chatTogether');

const mapMessages = (
  messages: BaseMessage[],
): CompletionCreateParams.Message[] =>
  messages.map((m) => {
    // eslint-disable-next-line no-underscore-dangle
    switch (m._getType()) {
      case 'system': {
        return { role: 'system', content: `${m.content}` };
      }
      case 'human': {
        return { role: 'user', content: `${m.content}` };
      }
      case 'ai': {
        const aiMsg = m as AIMessage;
        return {
          role: 'assistant',
          content: `${m.content}`,
          tool_calls: aiMsg.tool_calls?.length
            ? aiMsg.tool_calls?.map((f, idx) => ({
                index: idx,
                id: f.id,
                type: 'function',
                function: {
                  name: f.name,
                  arguments: f.args,
                },
              }))
            : undefined, // this probably needs better mapping
        };
      }
      case 'function':
      case 'tool': {
        const toolMsg = m as ToolMessage;
        return {
          role: 'tool',
          content: `${m.content}`,
          tool_call_id: toolMsg.tool_call_id,
          name: toolMsg.name,
        };
      }
      default: {
        throw new Error(`Unknown message type: ${JSON.stringify(m)}`);
      }
    }
  });

interface ChatHSTogetherAIInput extends BaseChatModelParams {
  model: string;
  apiKey: string;
}

export interface ChatHSTogetherAICallOptions extends BaseFunctionCallOptions {
  tools?: any[];
}

export class ChatHSTogetherAI extends SimpleChatModel<ChatHSTogetherAICallOptions> {
  model: string;

  apiKey: string;

  constructor(fields: ChatHSTogetherAIInput) {
    super(fields);
    this.model = fields.model || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
    this.apiKey = fields.apiKey || '';
  }

  // eslint-disable-next-line no-underscore-dangle, class-methods-use-this
  _llmType() {
    return 'hsTogetherAI';
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatHSTogetherAICallOptions>,
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    ChatHSTogetherAICallOptions
  > {
    return this.bind({
      tools: tools.map((tool) => convertToOpenAITool(tool)),
      ...kwargs,
    } as Partial<ChatHSTogetherAICallOptions>);
  }

  // eslint-disable-next-line no-underscore-dangle, class-methods-use-this
  async _call(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<string> {
    if (!messages.length) {
      throw new Error('No messages provided.');
    }
    // Pass `runManager?.getChild()` when invoking internal runnables to enable tracing
    // await subRunnable.invoke(params, runManager?.getChild());
    if (typeof messages[0].content !== 'string') {
      throw new Error('Multimodal messages are not supported.');
    }

    // log.debug(`Messages sent to together: ${JSON.stringify(messages)}`);
    const together = new Together({
      apiKey: this.apiKey,
      // fetch: (x: any, init: any): any => {
      //   log.debug(`Fetch: ${JSON.stringify(x)} init=${JSON.stringify(init)}`);
      //   return fetch(x, init);
      // },
    });
    const response = await together.chat.completions.create({
      messages: mapMessages(messages),
      model: this.model,
      stream: false,
      tools: options.tools,
    });

    const choice = response?.choices?.[0];
    if (choice && choice.message) {
      const chunk = this._convertOpenAIDeltaToBaseMessageChunk(
        choice.message,
        response.id,
        'assistant',
      );
      const newTokenIndices = {
        prompt: 0, // options.promptIndex ?? 0,
        completion: choice.index ?? 0,
      };
      if (typeof chunk.content !== 'string') {
        throw new Error(
          '[WARNING]: Received non-string content from TogetherAI. This is currently not supported.',
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generationInfo: Record<string, any> = {};
      if (choice.finish_reason != null) {
        generationInfo.finish_reason = choice.finish_reason;
        // Only include system fingerprint in the last chunk for now
        // to avoid concatenation issues
        // generationInfo.system_fingerprint = response.system_fingerprint;
        generationInfo.model_name = response.model;
      }
      const generationChunk = new ChatGenerationChunk({
        message: chunk,
        text: chunk.content,
        generationInfo,
      });
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? '',
        newTokenIndices,
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk },
      );
      return chunk.content;
    }

    throw new Error(`Bad response from LLM: ${JSON.stringify(response)}`);
  }

  /** @ignore */
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    // log.debug(`Messages sent to together: ${JSON.stringify(messages)}`);
    const together = new Together({
      apiKey: this.apiKey,
      // fetch: (x: any, init: any): any => {
      //   log.debug(`Fetch: ${JSON.stringify(x)} init=${JSON.stringify(init)}`);
      //   return fetch(x, init);
      // },
    });
    const response = await together.chat.completions.create({
      messages: mapMessages(messages),
      model: this.model,
      stream: false,
      tools: options.tools,
    });

    const generations: ChatGeneration[] = [];
    for (const part of response?.choices ?? []) {
      if (!part.message) {
        continue;
      }
      const text = part.message?.content ?? '';
      const generation: ChatGeneration = {
        text,
        message: this._convertOpenAIDeltaToBaseMessageChunk(
          part.message,
          response.id,
          'assistant',
        ),
      };
      generation.generationInfo = {
        ...(part.finish_reason ? { finish_reason: part.finish_reason } : {}),
        ...(part.logprobs ? { logprobs: part.logprobs } : {}),
      };
      // Fields are not serialized unless passed to the constructor
      // Doing this ensures all fields on the message are serialized
      generation.message = new AIMessage(
        Object.fromEntries(
          Object.entries(generation.message).filter(
            ([key]) => !key.startsWith('lc_'),
          ),
        ) as BaseMessageFields,
      );
      generations.push(generation);
    }
    return {
      generations,
    };
  }

  // eslint-disable-next-line class-methods-use-this
  protected _convertOpenAIDeltaToBaseMessageChunk(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delta: Record<string, any>,
    id: string,
    defaultRole?: string,
  ) {
    // log.debug(`Delta=${JSON.stringify(delta)}`);
    const role = delta.role ?? defaultRole;
    const content = delta.content ?? '';
    let additional_kwargs: Record<string, unknown>;
    if (delta.tool_calls) {
      additional_kwargs = {
        tool_calls: delta.tool_calls,
      };
    } else {
      additional_kwargs = {};
    }

    // log.debug(
    //   `CHUNK: ${content} toolcalls=${JSON.stringify(delta.tool_calls)}`,
    // );
    if (role === 'user') {
      return new HumanMessageChunk({ content });
    }
    if (role === 'assistant') {
      const toolCallChunks: ToolCallChunk[] = [];
      if (Array.isArray(delta.tool_calls)) {
        for (const rawToolCall of delta.tool_calls) {
          toolCallChunks.push({
            name: rawToolCall.function?.name,
            args: rawToolCall.function?.arguments,
            id: rawToolCall.id,
            index: rawToolCall.index,
            type: 'tool_call_chunk',
          });
        }
      }
      return new AIMessageChunk({
        content,
        tool_call_chunks: toolCallChunks,
        additional_kwargs,
        id,
      });
    }
    if (role === 'system') {
      return new SystemMessageChunk({ content });
    }
    if (role === 'developer') {
      return new SystemMessageChunk({
        content,
        additional_kwargs: {
          __openai_role__: 'developer',
        },
      });
    }
    if (role === 'tool') {
      return new ToolMessageChunk({
        content,
        additional_kwargs,
        tool_call_id: delta.tool_call_id,
      });
    }
    return new ChatMessageChunk({ content, role });
  }

  // eslint-disable-next-line no-underscore-dangle, class-methods-use-this
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    if (!messages.length) {
      throw new Error('No messages provided.');
    }
    if (typeof messages[0].content !== 'string') {
      throw new Error('Multimodal messages are not supported.');
    }

    // log.debug(
    //   `Messages sent to together for stream: ${JSON.stringify(messages)}`,
    // );
    const together = new Together({
      apiKey: this.apiKey,
      // fetch: (x: any, init: any): any => {
      //   log.debug(`Fetch: ${JSON.stringify(x)} init=${JSON.stringify(init)}`);
      //   return fetch(x, init);
      // },
    });
    const stream = await together.chat.completions.create({
      messages: mapMessages(messages),
      model: this.model,
      stream: true,
      tools: options.tools,
    });
    // Pass `runManager?.getChild()` when invoking internal runnables to enable tracing
    // await subRunnable.invoke(params, runManager?.getChild());
    // eslint-disable-next-line no-restricted-syntax
    let defaultRole: string | undefined;
    for await (const data of stream) {
      // const token = chunk.choices[0].delta.content || '';
      // yield new ChatGenerationChunk({
      //   message: new AIMessageChunk({
      //     content: token,
      //   }),
      //   text: token,
      // });
      // // Trigger the appropriate callback for new chunks
      // // eslint-disable-next-line no-await-in-loop
      // await runManager?.handleLLMNewToken(token);

      const choice = data?.choices?.[0];
      if (!choice) {
        continue;
      }

      const { delta } = choice;
      if (!delta) {
        continue;
      }
      const chunk = this._convertOpenAIDeltaToBaseMessageChunk(
        delta,
        data.id,
        defaultRole,
      );
      defaultRole = delta.role ?? defaultRole;
      const newTokenIndices = {
        prompt: 0, // options.promptIndex ?? 0,
        completion: choice.index ?? 0,
      };
      if (typeof chunk.content !== 'string') {
        log.warn(
          '[WARNING]: Received non-string content from TogetherAI. This is currently not supported.',
        );
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generationInfo: Record<string, any> = { ...newTokenIndices };
      if (choice.finish_reason != null) {
        generationInfo.finish_reason = choice.finish_reason;
        // Only include system fingerprint in the last chunk for now
        // to avoid concatenation issues
        generationInfo.system_fingerprint = data.system_fingerprint;
        generationInfo.model_name = data.model;
      }
      const generationChunk = new ChatGenerationChunk({
        message: chunk,
        text: chunk.content,
        generationInfo,
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? '',
        newTokenIndices,
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk },
      );
    }
  }
}
