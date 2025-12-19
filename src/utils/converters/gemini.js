// Gemini 格式转换工具
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getReasoningSignature } from '../thoughtSignatureCache.js';
import { getThoughtSignatureForModel, modelMapping, isEnableThinking } from '../utils.js';

export function generateGeminiRequestBody(geminiBody, modelName, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);

  const request = JSON.parse(JSON.stringify(geminiBody));

  if (request.contents && Array.isArray(request.contents)) {
    const functionCallIds = [];
    request.contents.forEach(content => {
      if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
        content.parts.forEach(part => {
          if (part.functionCall) {
            if (!part.functionCall.id) {
              part.functionCall.id = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            functionCallIds.push(part.functionCall.id);
          }
        });
      }
    });

    let responseIndex = 0;
    request.contents.forEach(content => {
      if (content.role === 'user' && content.parts && Array.isArray(content.parts)) {
        content.parts.forEach(part => {
          if (part.functionResponse) {
            if (!part.functionResponse.id && responseIndex < functionCallIds.length) {
              part.functionResponse.id = functionCallIds[responseIndex];
              responseIndex++;
            }
          }
        });
      }
    });

    if (enableThinking) {
      const cachedSig = getReasoningSignature(token.sessionId, actualModelName);
      const thoughtSignature = cachedSig || getThoughtSignatureForModel(actualModelName);

      request.contents.forEach(content => {
        if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
          const hasThought = content.parts.some(p => p.thought === true);
          if (!hasThought) {
            content.parts.unshift(
              { text: ' ', thought: true },
              { text: ' ', thoughtSignature }
            );
          }
        }
      });
    }
  }

  if (!request.generationConfig) {
    request.generationConfig = {};
  }

  if (enableThinking) {
    const defaultThinkingBudget = config.defaults.thinking_budget ?? 1024;
    if (!request.generationConfig.thinkingConfig) {
      request.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: defaultThinkingBudget
      };
    }
  }

  request.generationConfig.candidateCount = 1;
  request.sessionId = token.sessionId;
  delete request.safetySettings;

  const existingText = request.systemInstruction?.parts?.[0]?.text || '';
  const mergedText = existingText ? `${config.systemInstruction}\n\n${existingText}` : config.systemInstruction ?? "";
  request.systemInstruction = {
    role: 'user',
    parts: [{ text: mergedText }]
  };
  
  //console.log(JSON.stringify(request, null, 2))

  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: request,
    model: actualModelName,
    userAgent: 'antigravity'
  };

  return requestBody;
}
