import { EventEmitter } from 'stream';
import { v4 } from 'uuid';

import { HumanMessage } from '@langchain/core/messages';
// import { BaseCheckpointSaver } from '@langchain/langgraph';
// import { ChatOllama } from '@langchain/ollama';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
// import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  BaseCheckpointSaver,
  MemorySaver,
} from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';

import config from '../config';
import logging from '../logging';
import { ToolArgumentDef, ToolDef } from './types';
import { ChatHSTogetherAI } from './chat-together';
import { getConnectionPoolFromConfigPrefix } from '../pg/pgconfig';

const log = logging('langchain:stream');

const wrapZodNodeWithDesc = (item: any, ad: ToolArgumentDef) => {
  const itemNullable = ad.required ? item : item.nullable();
  return itemNullable.describe(ad.description);
};

export const convertToLangchainTool = (def: ToolDef): DynamicStructuredTool =>
  tool(async (input) => def.callable(input), {
    name: def.name,
    description: def.description,
    schema: z.object(
      def.argDefs.reduce((acc: Record<string, any>, ad) => {
        if (ad.type === 'number') {
          acc[ad.name] = wrapZodNodeWithDesc(z.number(), ad);
        } else if (ad.type === 'date') {
          acc[ad.name] = wrapZodNodeWithDesc(z.date(), ad);
        } else {
          acc[ad.name] = wrapZodNodeWithDesc(z.string(), ad);
        }
        return acc;
      }, {}),
    ),
  });

const streaming = (config.get('llm:streaming') || 'false') === 'true';

export const getCheckpointSaver = async (): Promise<BaseCheckpointSaver> => {
  const checkpointerDBHost = (
    config.get('llm:checkpointer:db:host') || ''
  ).trim();
  if (checkpointerDBHost !== '') {
    log.debug('Using postgres checkpointer');
    const checkpointer = new PostgresSaver(
      getConnectionPoolFromConfigPrefix('llm:checkpointer:db'),
    );
    await checkpointer.setup();
    return checkpointer;
  }
  log.debug('Using memory checkpointer');
  return new MemorySaver();
};
const checkpointSaver: Promise<BaseCheckpointSaver> = getCheckpointSaver();

export const getModel = async (): Promise<BaseChatModel> => {
  const llmType = config.get('llm:type') || 'openAI';
  if (llmType === 'openAI') {
    const modelName = config.get('llm:modelName') || 'gpt-4-turbo';
    const apiKey = config.get('llm:apiKey') || '';
    const baseURL = config.get('llm:baseUrl') || '';
    if (apiKey === '' && baseURL === '') {
      log.warn('WARNING: openAI api key and baseURL are both not set');
    }
    return new ChatOpenAI({
      model: modelName,
      apiKey,
      streaming,
      configuration: baseURL === '' ? undefined : { baseURL },
    });
  }
  if (llmType === 'togetherAI') {
    const modelName =
      config.get('llm:modelName') || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
    const apiKey = config.get('llm:apiKey') || '';
    if (apiKey === '') {
      log.warn('WARNING: togetherAI api key is not set');
    }
    return new ChatHSTogetherAI({
      model: modelName,
      apiKey,
    });
  }
  if (llmType === 'bedrock') {
    const modelName =
      config.get('llm:modelName') || 'us.meta.llama3-3-70b-instruct-v1:0';
    const modelRegion = config.get('llm:bedrock:modelRegion');
    const bedrockAccessKeyId = config.get('llm:bedrock:awsAccessKeyId');
    const bedrockSecretAccessKey = config.get('llm:bedrock:awsSecretAccessKey');
    const temperature = parseFloat(
      config.get('llm:bedrock:temperature') || '0.5',
    );
    if (bedrockAccessKeyId === '') {
      log.warn('WARNING: AWS bedrock accessKeyId is not set');
    }
    if (bedrockSecretAccessKey === '') {
      log.warn('WARNING: AWS bedrock secretAccessKey is not set');
    }
    return new ChatBedrockConverse({
      model: modelName,
      region: modelRegion,
      streaming,
      maxTokens: 4096,
      temperature,
      credentials: {
        accessKeyId: bedrockAccessKeyId,
        secretAccessKey: bedrockSecretAccessKey,
      },
    });
  }
  throw new Error(`Unknown LLM type: ${llmType}`);
};

export const llmResponseForConversation = async (
  evt: EventEmitter,
  llm: BaseChatModel,
  promptText: string,
  toolset: ToolDef[],
  threadId: string,
  thisInputText: string,
): Promise<void> => {
  // log.debug(`Tools available: ${toolset.map((x) => x.name).join(', ')}`);
  const langchainTools = toolset.map(convertToLangchainTool);
  if (langchainTools.length === 0) {
    throw new Error(
      `Langchain implementation requires at least one tool defined`,
    );
  }

  const graph = createReactAgent({
    llm,
    tools: langchainTools,
    checkpointSaver: await checkpointSaver,
    prompt: promptText,
  });

  try {
    if (!streaming) {
      const runId = v4();
      evt.emit('start', { runId });
      const result = await graph.invoke(
        {
          messages: [new HumanMessage(thisInputText)],
        },
        { configurable: { thread_id: threadId } },
      );
      const { messages } = result;
      // log.debug(`Messages=${JSON.stringify(messages)}`);
      const output = messages[messages.length - 1].content;
      evt.emit('finish', { runId, output });
      return;
    }

    const eventStream = await graph.streamEvents(
      {
        messages: [new HumanMessage(thisInputText)],
      },
      { version: 'v2', configurable: { thread_id: threadId } },
    );

    let runId;
    // eslint-disable-next-line no-restricted-syntax
    for await (const event of eventStream) {
      // log.debug(`evt: ${JSON.stringify(event)}`);
      switch (event.event) {
        case 'on_chain_start': {
          if (event.name === 'LangGraph') {
            runId = event.run_id;
            evt.emit('start', { runId });
          }
          break;
        }
        case 'on_chain_end': {
          if (event.name === 'LangGraph') {
            const { messages } = event.data.output;
            const output = messages[messages.length - 1].content;
            evt.emit('finish', { runId, output });
          }
          break;
        }
        case 'on_chat_model_stream': {
          const content = event.data?.chunk?.content;
          // log.debug(`on_chat_model_stream: ${content}`);
          evt.emit('llmToken', { token: content, runId });
          break;
        }
        // case 'on_tool_start': {
        //   log.debug(
        //     `Tool started: ${event.name} with inputs: ${event.data.input?.input}`,
        //   );
        //   break;
        // }
        // case 'on_tool_end': {
        //   log.debug(
        //     `Tool ended: ${event.name} with outputs: ${JSON.stringify(event.data.output?.content)}`,
        //   );
        //   break;
        // }
        default: {
          // log.debug(`Unknown event type: ${JSON.stringify(event.event)}`);
          break;
        }
      }
    }
  } catch (err) {
    log.error(`Error communicating with AI: `, err);
    evt.emit('error', {
      message: 'Error communicating with AI (possibly check account balance?)',
    });
  }
};
