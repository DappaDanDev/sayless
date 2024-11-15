// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  multimodal,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { normalize } from 'viem/ens';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env.local');
dotenv.config({ path: envPath });

// Create Ethereum public client for ENS lookups
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL), // Add ETH_RPC_URL to your .env.local
});

// Add chain mapping
const CHAIN_IDS = {
  'ethereum': '1',
  'base': '8453',
  'polygon': '137',
  'arbitrum': '42161',
  'optimism': '10',
  'avalanche': '43114',
} as const;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const model = new openai.realtime.RealtimeModel({
      instructions: `You are a helpful assistant that helps users look up wallet balances and transaction history. Follow this flow:

      1. Start by asking "How can I help you?"

      2. When a user asks about wallet balance or transaction history:
         - If they haven't specified a chain, ask which chain they want to check
         - Use confirmEnsName to verify the name/address with the user
         - For transaction history, if they haven't specified a limit, ask how many transactions they want to see (max 100)
         - Wait for their response
      
      2. If they say "no" to the name confirmation:
         - Use spellEnsName to spell out the name letter by letter
         - After spelling it out, ask if that's correct
         - If they say "no", use spellEnsName again
         - If they say "yes", proceed to the next step
      
      3. Only after getting confirmation ("yes"):
         - Use getWalletBalance to fetch the balance
         - Use getTransactionHistory to fetch the transaction history`,
      voice: 'alloy',
      outputAudioFormat: 'pcm16',
      inputAudioFormat: 'pcm16'
    });

    const fncCtx: llm.FunctionContext = {
      confirmEnsName: {
        description: 'Confirm the ENS name spelling with the user',
        parameters: z.object({
          name: z.string().describe('The name to confirm'),
        }),
        execute: async ({ name }) => {
          // Normalize and append .eth if not present
          const ensName = normalize(name.endsWith('.eth') ? name : `${name}.eth`);
          return `I want to look up the balance for "${ensName}". Is this spelling correct? Please respond with "yes" to proceed or "no" to spell it letter by letter.`;
        },
      },

      spellEnsName: {
        description: 'Spell out ENS name letter by letter to the user',
        parameters: z.object({
          currentAttempt: z.string().describe('The ENS name to spell out'),
        }),
        execute: async ({ currentAttempt }) => {
          const spelled = currentAttempt.split('').join(', ');
          return `Let me spell that out for you: ${spelled}. Is this correct? Please respond with "yes" or "no".`;
        },
      },

      getWalletBalance: {
        description: 'Get the balance of an Ethereum wallet address or ENS name after confirmation',
        parameters: z.object({
          addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
          chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
        }),
        execute: async ({ addressOrName, chain }) => {
          const chainId = CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
          try {
            // First, try to resolve ENS name if it's not already an address
            let resolvedAddress = addressOrName;
            if (!addressOrName.startsWith('0x')) {
              console.debug(`attempting to resolve ENS name: ${addressOrName}`);
              // Normalize and append .eth if not present
              const ensName = normalize(addressOrName.endsWith('.eth') ? addressOrName : `${addressOrName}.eth`);
              
              const address = await publicClient.getEnsAddress({
                name: ensName,
              });

              if (!address) {
                return `Could not resolve ENS name ${ensName} to an address`;
              }
              
              console.debug(`resolved ${ensName} to ${address}`);
              resolvedAddress = address;
            }

            // Now fetch the balance using 1inch API with ONLY the resolved address
            console.debug(`checking balance for wallet address ${resolvedAddress}`);
            const response = await fetch(
              `https://api.1inch.dev/balance/v1.2/${chainId}/balances/${resolvedAddress}`,
              {
                headers: {
                  'Authorization': `Bearer ${process.env.INCH_API_KEY}`,
                  'Accept': 'application/json',
                }
              }
            );

            if (!response.ok) {
              throw new Error(`1inch API returned status: ${response.status}`);
            }

            const data = await response.json();
            return `The wallet ${addressOrName} (${resolvedAddress}) has the following balances: ${JSON.stringify(data, null, 2)}`;
          } catch (error: unknown) {
            console.error('Error fetching wallet balance:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Sorry, I couldn't fetch the balance. Error: ${errorMessage}`;
          }
        },
      },

      getTransactionHistory: {
        description: 'Get transaction history for an Ethereum wallet address or ENS name',
        parameters: z.object({
          addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
          chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
          limit: z.number().optional().describe('Number of transactions to fetch (max 100)'),
        }),
        execute: async ({ addressOrName, chain, limit }) => {
          const chainId = CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
          try {
            // Resolve ENS name if provided
            let resolvedAddress = addressOrName;
            if (!addressOrName.startsWith('0x')) {
              const ensName = normalize(addressOrName.endsWith('.eth') ? addressOrName : `${addressOrName}.eth`);
              const address = await publicClient.getEnsAddress({
                name: ensName,
              });
              if (!address) {
                return `Could not resolve ENS name ${ensName} to an address`;
              }
              resolvedAddress = address;
            }

            // Use default limit of 10 if not specified
            const queryLimit = limit || 10;
            if (queryLimit > 100) {
              return "Sorry, the maximum limit for transactions is 100. Please specify a lower number.";
            }

            const response = await fetch(
              `https://api.1inch.dev/history/v1.2/${chainId}/history/events?address=${resolvedAddress}&limit=${queryLimit}`,
              {
                headers: {
                  'Authorization': `Bearer ${process.env.INCH_API_KEY}`,
                  'Accept': 'application/json',
                }
              }
            );

            if (!response.ok) {
              throw new Error(`1inch API returned status: ${response.status}`);
            }

            const data = await response.json();
            return `Here are the last ${queryLimit} transactions for ${addressOrName} (${resolvedAddress}): ${JSON.stringify(data, null, 2)}`;
          } catch (error: unknown) {
            console.error('Error fetching transaction history:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Sorry, I couldn't fetch the transaction history. Error: ${errorMessage}`;
          }
        },
      },
    };
    const agent = new multimodal.MultimodalAgent({ model, fncCtx });
    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);

    // Configure session with proper modalities and audio format
    session.sessionUpdate({
      modalities: ["text", "audio"],  // Specify both text and audio modalities
      outputAudioFormat: "pcm16"      // Use PCM16 format for audio
    });

    session.conversation.item.create(llm.ChatMessage.create({
      role: llm.ChatRole.ASSISTANT,
      text: 'How can I help you today?'
    }));

    session.response.create();
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
