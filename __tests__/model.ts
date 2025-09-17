import { ChatHSTogetherAI } from '../lib/langchain/chat-together';

it('should compile the chat togetherai correctly', () => {
  // needs es2021 setting in tsconfig
  const model = new ChatHSTogetherAI({
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    apiKey: '',
  });
  expect(model).toBeTruthy();
});
