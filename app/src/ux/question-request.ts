import type { QuestionRequest } from '@/src/opencode/types';
import type { ServerEvent } from '@/src/opencode/sse';

export interface QuestionSubmission {
  requestID: string;
  answers: string[][];
}

export function createQuestionRequestModel(request: QuestionRequest) {
  const single = request.questions.length === 1 && request.questions[0]?.multiple !== true;
  const autoSubmitSingleChoice = single && request.questions[0]?.custom === false;
  return {
    id: request.id,
    sessionID: request.sessionID,
    tabs: [
      ...request.questions.map((question, index) => ({
        id: `question-${index}`,
        header: question.header,
        question: question.question,
        options: question.options,
        multiple: question.multiple === true,
        custom: question.custom !== false,
      })),
      ...(!single ? [{ id: 'confirm' as const, header: 'Confirm' }] : []),
    ],
    autoSubmitSingleChoice,
  };
}

export function createQuestionSubmission(request: QuestionRequest, answers: string[][]): QuestionSubmission {
  return {
    requestID: request.id,
    answers: request.questions.map((_, index) => answers[index] ?? []),
  };
}

export function applyQuestionEvent(current: Record<string, QuestionRequest[]>, event: ServerEvent) {
  if (event.type === 'question.asked') {
    const request = event.properties as unknown as QuestionRequest;
    const existing = current[request.sessionID] ?? [];
    const withoutRequest = existing.filter((item) => item.id !== request.id);
    return { ...current, [request.sessionID]: [...withoutRequest, request] };
  }
  if (event.type !== 'question.replied' && event.type !== 'question.rejected') return current;
  const properties = event.properties as unknown as { sessionID?: string; requestID?: string };
  if (!properties.sessionID || !properties.requestID) return current;
  return {
    ...current,
    [properties.sessionID]: (current[properties.sessionID] ?? []).filter((item) => item.id !== properties.requestID),
  };
}
