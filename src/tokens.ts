export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContextTokens(messages: readonly { content: string }[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content), 0);
}
