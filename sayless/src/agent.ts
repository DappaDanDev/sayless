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

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const model = new openai.realtime.RealtimeModel({
      instructions: `You are a helpful assistant that helps users look up wallet balances. ALWAYS follow this exact flow:

      1. When a user asks about ANY wallet balance (whether ENS name or address):
         - First use confirmEnsName to verify the name/address with the user
         - Wait for their response
      
      2. If they say "no":
         - Use spellEnsName to help them spell it letter by letter
         - Continue using spellEnsName until they say "done"
         - Use the final spelling for the next step
      
      3. Only after getting confirmation ("yes") or completed spelling ("done"):
         - Use getWalletBalance to fetch the balance
      
      Example correct flow:
      User: "What's vitalik.eth's balance?"
      Assistant: (uses confirmEnsName with "vitalik.eth")
      User: "yes"
      Assistant: (uses getWalletBalance)

      Example correction flow:
      User: "What's vitalik.eth's balance?"
      Assistant: (uses confirmEnsName with "vitalik.eth")
      User: "no"
      Assistant: (uses spellEnsName repeatedly until user says "done")
      Assistant: (uses getWalletBalance with final spelling)

      IMPORTANT: Never skip the confirmation step, even if the name seems correct.`
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
        description: 'Help user spell out ENS name letter by letter',
        parameters: z.object({
          currentAttempt: z.string().describe('The current attempt at spelling the name'),
        }),
        execute: async ({ currentAttempt }) => {
          return `Let's spell the ENS name letter by letter. ${
            currentAttempt ? `So far we have: "${currentAttempt}". ` : ''
          }What is the next letter? (When finished, say "done")`;
        },
      },

      getWalletBalance: {
        description: 'Get the balance of an Ethereum wallet address or ENS name after confirmation',
        parameters: z.object({
          addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
        }),
        execute: async ({ addressOrName }) => {
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
              `https://api.1inch.dev/balance/v1.2/1/balances/${resolvedAddress}`,
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
    };
    const agent = new multimodal.MultimodalAgent({ model, fncCtx });
    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);

    session.conversation.item.create(llm.ChatMessage.create({
      role: llm.ChatRole.ASSISTANT,
      text: 'How can I help you today?'
    }));

    session.response.create();
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
