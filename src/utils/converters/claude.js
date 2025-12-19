// Claude 格式转换工具
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getReasoningSignature } from '../thoughtSignatureCache.js';
import { setToolNameMapping } from '../toolNameCache.js';
import { getThoughtSignatureForModel, sanitizeToolName, cleanParameters, modelMapping, isEnableThinking, generateGenerationConfig } from '../utils.js';

function extractImagesFromClaudeContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text || '';
      } else if (item.type === 'image') {
        const source = item.source;
        if (source && source.type === 'base64' && source.data) {
          result.images.push({
            inlineData: {
              mimeType: source.media_type || 'image/png',
              data: source.data
            }
          });
        }
      }
    }
  }
  return result;
}

function handleClaudeUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: 'user',
    parts: [{ text: extracted.text }, ...extracted.images]
  });
}

function handleClaudeAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const content = message.content;

  let textContent = '';
  const toolCalls = [];

  if (typeof content === 'string') {
    textContent = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        textContent += item.text || '';
      } else if (item.type === 'tool_use') {
        const originalName = item.name;
        const safeName = sanitizeToolName(originalName);
        const part = {
          functionCall: {
            id: item.id,
            name: safeName,
            args: { query: JSON.stringify(item.input || {}) }
          }
        };
        if (sessionId && actualModelName && safeName !== originalName) {
          setToolNameMapping(sessionId, actualModelName, safeName, originalName);
        }
        toolCalls.push(part);
      }
    }
  }

  const hasToolCalls = toolCalls.length > 0;
  const hasContent = textContent && textContent.trim() !== '';

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...toolCalls);
  } else {
    const parts = [];
    if (enableThinking) {
      const cachedSig = getReasoningSignature(sessionId, actualModelName);
      const thoughtSignature = cachedSig || getThoughtSignatureForModel(actualModelName);
      parts.push({ text: ' ', thought: true });
      parts.push({ text: ' ', thoughtSignature });
    }
    if (hasContent) parts.push({ text: textContent.trimEnd() });
    parts.push(...toolCalls);
    antigravityMessages.push({ role: 'model', parts });
  }
}

function handleClaudeToolResult(message, antigravityMessages) {
  const content = message.content;
  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (item.type !== 'tool_result') continue;

    const toolUseId = item.tool_use_id;
    let functionName = '';
    for (let i = antigravityMessages.length - 1; i >= 0; i--) {
      if (antigravityMessages[i].role === 'model') {
        const parts = antigravityMessages[i].parts;
        for (const part of parts) {
          if (part.functionCall && part.functionCall.id === toolUseId) {
            functionName = part.functionCall.name;
            break;
          }
        }
        if (functionName) break;
      }
    }

    const lastMessage = antigravityMessages[antigravityMessages.length - 1];
    let resultContent = '';
    if (typeof item.content === 'string') {
      resultContent = item.content;
    } else if (Array.isArray(item.content)) {
      resultContent = item.content.filter(c => c.type === 'text').map(c => c.text).join('');
    }

    const functionResponse = {
      functionResponse: {
        id: toolUseId,
        name: functionName,
        response: { output: resultContent }
      }
    };

    if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
      lastMessage.parts.push(functionResponse);
    } else {
      antigravityMessages.push({ role: 'user', parts: [functionResponse] });
    }
  }
}

function claudeMessageToAntigravity(claudeMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  for (const message of claudeMessages) {
    if (message.role === 'user') {
      const content = message.content;
      if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) {
        handleClaudeToolResult(message, antigravityMessages);
      } else {
        const extracted = extractImagesFromClaudeContent(content);
        handleClaudeUserMessage(extracted, antigravityMessages);
      }
    } else if (message.role === 'assistant') {
      handleClaudeAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
    }
  }
  return antigravityMessages;
}

function convertClaudeToolsToAntigravity(claudeTools, sessionId, actualModelName) {
  if (!claudeTools || claudeTools.length === 0) return [];
  return claudeTools.map((tool) => {
    const rawParams = tool.input_schema || {};
    const cleanedParams = cleanParameters(rawParams) || {};
    if (cleanedParams.type === undefined) cleanedParams.type = 'object';
    if (cleanedParams.type === 'object' && cleanedParams.properties === undefined) cleanedParams.properties = {};

    const originalName = tool.name;
    const safeName = sanitizeToolName(originalName);
    if (sessionId && actualModelName && safeName !== originalName) {
      setToolNameMapping(sessionId, actualModelName, safeName, originalName);
    }

    return {
      functionDeclarations: [{
        name: safeName,
        description: tool.description || '',
        parameters: cleanedParams
      }]
    };
  });
}

export function generateClaudeRequestBody(claudeMessages, modelName, parameters, claudeTools, systemPrompt, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);

  const baseSystem = config.systemInstruction || '';
  let mergedSystem = '';
  if (config.useContextSystemPrompt && systemPrompt) {
    const parts = [];
    if (baseSystem.trim()) parts.push(baseSystem.trim());
    if (systemPrompt.trim()) parts.push(systemPrompt.trim());
    mergedSystem = parts.join('\n\n');
  } else {
    mergedSystem = baseSystem;
  }

  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: claudeMessageToAntigravity(claudeMessages, enableThinking, actualModelName, token.sessionId),
      tools: convertClaudeToolsToAntigravity(claudeTools, token.sessionId, actualModelName),
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity'
  };

  if (mergedSystem) {
    requestBody.request.systemInstruction = {
      role: 'user',
      parts: [{ text: mergedSystem }]
    };
  }

  return requestBody;
}
