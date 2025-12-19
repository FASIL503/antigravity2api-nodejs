// OpenAI 格式转换工具
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getReasoningSignature, getToolSignature } from '../thoughtSignatureCache.js';
import { setToolNameMapping } from '../toolNameCache.js';
import { getThoughtSignatureForModel, getToolSignatureForModel, sanitizeToolName, cleanParameters, modelMapping, isEnableThinking, generateGenerationConfig, extractSystemInstruction } from '../utils.js';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          result.images.push({
            inlineData: {
              mimeType: `image/${match[1]}`,
              data: match[2]
            }
          });
        }
      }
    }
  }
  return result;
}

function handleUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: 'user',
    parts: [{ text: extracted.text }, ...extracted.images]
  });
}

function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';

  const antigravityTools = hasToolCalls
    ? message.tool_calls.map(toolCall => {
        const originalName = toolCall.function.name;
        const safeName = sanitizeToolName(originalName);
        const part = {
          functionCall: {
            id: toolCall.id,
            name: safeName,
            args: { query: toolCall.function.arguments }
          }
        };
        if (sessionId && actualModelName && safeName !== originalName) {
          setToolNameMapping(sessionId, actualModelName, safeName, originalName);
        }
        if (enableThinking) {
          const cachedToolSig = getToolSignature(sessionId, actualModelName);
          part.thoughtSignature = toolCall.thoughtSignature || cachedToolSig || getToolSignatureForModel(actualModelName);
        }
        return part;
      })
    : [];

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...antigravityTools);
  } else {
    const parts = [];
    if (enableThinking) {
      const cachedSig = getReasoningSignature(sessionId, actualModelName);
      const thoughtSignature = message.thoughtSignature || cachedSig || getThoughtSignatureForModel(actualModelName);
      const reasoningText = (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) ? message.reasoning_content : ' ';
      parts.push({ text: reasoningText, thought: true });
      parts.push({ text: ' ', thoughtSignature });
    }
    if (hasContent) parts.push({ text: message.content.trimEnd() });
    parts.push(...antigravityTools);
    antigravityMessages.push({ role: 'model', parts });
  }
}

function handleToolCall(message, antigravityMessages) {
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: { output: message.content }
    }
  };

  if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({ role: 'user', parts: [functionResponse] });
  }
}

function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === 'assistant') {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
    } else if (message.role === 'tool') {
      handleToolCall(message, antigravityMessages);
    }
  }
  return antigravityMessages;
}

function convertOpenAIToolsToAntigravity(openaiTools, sessionId, actualModelName) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool) => {
    const rawParams = tool.function?.parameters || {};
    const cleanedParams = cleanParameters(rawParams) || {};
    if (cleanedParams.type === undefined) cleanedParams.type = 'object';
    if (cleanedParams.type === 'object' && cleanedParams.properties === undefined) cleanedParams.properties = {};

    const originalName = tool.function?.name;
    const safeName = sanitizeToolName(originalName);
    if (sessionId && actualModelName && safeName !== originalName) {
      setToolNameMapping(sessionId, actualModelName, safeName, originalName);
    }

    return {
      functionDeclarations: [{
        name: safeName,
        description: tool.function.description,
        parameters: cleanedParams
      }]
    };
  });
}

export function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);
  let filteredMessages = openaiMessages;
  let startIndex = 0;
  if (config.useContextSystemPrompt) {
    for (let i = 0; i < openaiMessages.length; i++) {
      if (openaiMessages[i].role === 'system') {
        startIndex = i + 1;
      } else {
        filteredMessages = openaiMessages.slice(startIndex);
        break;
      }
    }
  }

  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: openaiMessageToAntigravity(filteredMessages, enableThinking, actualModelName, token.sessionId),
      tools: convertOpenAIToolsToAntigravity(openaiTools, token.sessionId, actualModelName),
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity'
  };

  if (mergedSystemInstruction) {
    requestBody.request.systemInstruction = {
      role: 'user',
      parts: [{ text: mergedSystemInstruction }]
    };
  }

  return requestBody;
}
